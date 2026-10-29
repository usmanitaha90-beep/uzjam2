#define INITGUID
#include <initguid.h>

#include <windows.h>
#include <audioenginebaseapo.h>
#include <audiomediatype.h>
#include <ks.h>
#include <ksmedia.h>

#include <cmath>
#include <cstdio>
#include <vector>

using DllGetClassObjectFn = HRESULT(__stdcall *)(REFCLSID, REFIID, void **);
using DllCanUnloadNowFn = HRESULT(__stdcall *)();

int Fail(const char *message, HRESULT status = E_FAIL) {
    std::fprintf(stderr, "%s (HRESULT 0x%08lx)\n", message,
                 static_cast<unsigned long>(status));
    return 1;
}

int wmain(int argc, wchar_t **argv) {
    if (argc != 2) {
        std::fprintf(stderr, "usage: apo_smoke.exe <uzjam_endpoint_apo.dll>\n");
        return 2;
    }

    HMODULE module = LoadLibraryW(argv[1]);
    if (module == nullptr) {
        return Fail("LoadLibraryW failed", HRESULT_FROM_WIN32(GetLastError()));
    }
    auto get_class = reinterpret_cast<DllGetClassObjectFn>(
        GetProcAddress(module, "DllGetClassObject"));
    auto can_unload = reinterpret_cast<DllCanUnloadNowFn>(
        GetProcAddress(module, "DllCanUnloadNow"));
    if (get_class == nullptr || can_unload == nullptr) {
        return Fail("required COM exports are missing");
    }

    CLSID clsid{};
    HRESULT status =
        CLSIDFromString(L"{7EC11543-6693-43CE-B7DA-50512A736FF8}", &clsid);
    if (FAILED(status)) {
        return Fail("CLSIDFromString failed", status);
    }

    IClassFactory *factory = nullptr;
    status = get_class(clsid, __uuidof(IClassFactory),
                       reinterpret_cast<void **>(&factory));
    if (FAILED(status)) {
        return Fail("DllGetClassObject failed", status);
    }

    IAudioProcessingObject *apo = nullptr;
    status = factory->CreateInstance(nullptr, __uuidof(IAudioProcessingObject),
                                     reinterpret_cast<void **>(&apo));
    factory->Release();
    if (FAILED(status)) {
        return Fail("CreateInstance failed", status);
    }

    IAudioProcessingObjectConfiguration *configuration = nullptr;
    IAudioProcessingObjectRT *realtime = nullptr;
    status = apo->QueryInterface(__uuidof(IAudioProcessingObjectConfiguration),
                                 reinterpret_cast<void **>(&configuration));
    if (SUCCEEDED(status)) {
        status = apo->QueryInterface(__uuidof(IAudioProcessingObjectRT),
                                     reinterpret_cast<void **>(&realtime));
    }
    if (FAILED(status)) {
        return Fail("required APO interfaces are missing", status);
    }

    APO_REG_PROPERTIES *registration = nullptr;
    status = apo->GetRegistrationProperties(&registration);
    if (FAILED(status) || registration == nullptr ||
        registration->u32MinInputConnections != 1 ||
        registration->u32MinOutputConnections != 1) {
        return Fail("registration properties are invalid", status);
    }
    CoTaskMemFree(registration);

    status = apo->Initialize(0, nullptr);
    if (FAILED(status)) {
        return Fail("test initialization failed", status);
    }

    UNCOMPRESSEDAUDIOFORMAT format{};
    format.guidFormatType = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
    format.dwSamplesPerFrame = 2;
    format.dwBytesPerSampleContainer = sizeof(float);
    format.dwValidBitsPerSample = 32;
    format.fFramesPerSecond = 48'000.0f;
    format.dwChannelMask = KSAUDIO_SPEAKER_STEREO;
    IAudioMediaType *media_type = nullptr;
    status = CreateAudioMediaTypeFromUncompressedAudioFormat(&format, &media_type);
    if (FAILED(status)) {
        return Fail("media type creation failed", status);
    }

    constexpr UINT32 frame_count = 512;
    std::vector<float> input(frame_count * 2, 0.25f);
    std::vector<float> output(frame_count * 2, -1.0f);
    APO_CONNECTION_DESCRIPTOR input_descriptor{
        APO_CONNECTION_BUFFER_TYPE_EXTERNAL,
        reinterpret_cast<UINT_PTR>(input.data()), frame_count, media_type,
        APO_CONNECTION_DESCRIPTOR_SIGNATURE};
    APO_CONNECTION_DESCRIPTOR output_descriptor{
        APO_CONNECTION_BUFFER_TYPE_EXTERNAL,
        reinterpret_cast<UINT_PTR>(output.data()), frame_count, media_type,
        APO_CONNECTION_DESCRIPTOR_SIGNATURE};
    APO_CONNECTION_DESCRIPTOR *inputs[] = {&input_descriptor};
    APO_CONNECTION_DESCRIPTOR *outputs[] = {&output_descriptor};
    status = configuration->LockForProcess(1, inputs, 1, outputs);
    media_type->Release();
    if (FAILED(status)) {
        return Fail("LockForProcess failed", status);
    }

    HNSTIME latency = 0;
    status = apo->GetLatency(&latency);
    if (FAILED(status) || latency != 50'000) {
        return Fail("fixed 5 ms latency was not reported", status);
    }

    APO_CONNECTION_PROPERTY input_property{
        reinterpret_cast<UINT_PTR>(input.data()), frame_count, BUFFER_VALID,
        APO_CONNECTION_PROPERTY_SIGNATURE};
    APO_CONNECTION_PROPERTY output_property{
        reinterpret_cast<UINT_PTR>(output.data()), 0, BUFFER_INVALID,
        APO_CONNECTION_PROPERTY_SIGNATURE};
    APO_CONNECTION_PROPERTY *input_properties[] = {&input_property};
    APO_CONNECTION_PROPERTY *output_properties[] = {&output_property};
    realtime->APOProcess(1, input_properties, 1, output_properties);

    if (output_property.u32ValidFrameCount != frame_count ||
        output_property.u32BufferFlags != BUFFER_VALID) {
        return Fail("APOProcess returned invalid connection metadata");
    }
    for (UINT32 frame = 0; frame < frame_count; ++frame) {
        const float expected = frame < 240 ? 0.0f : 0.25f;
        if (std::fabs(output[frame * 2] - expected) > 1.0e-6f ||
            std::fabs(output[frame * 2 + 1] - expected) > 1.0e-6f) {
            std::fprintf(stderr,
                         "first mismatch at frame %u: expected %.6f, got %.6f / %.6f\n",
                         frame, expected, output[frame * 2], output[frame * 2 + 1]);
            return Fail("APOProcess did not produce the expected delayed flat signal");
        }
    }

    status = configuration->UnlockForProcess();
    realtime->Release();
    configuration->Release();
    apo->Release();
    if (FAILED(status)) {
        return Fail("UnlockForProcess failed", status);
    }
    if (can_unload() != S_OK) {
        return Fail("DLL retained COM objects after release");
    }
    FreeLibrary(module);
    std::puts("UZjam endpoint APO COM, format, latency, and DSP smoke test passed.");
    return 0;
}
