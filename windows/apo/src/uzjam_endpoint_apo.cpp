#define INITGUID
#include <initguid.h>

#include <windows.h>
#include <audioenginebaseapo.h>
#include <audioengineextensionapo.h>
#include <baseaudioprocessingobject.h>
#include <mmdeviceapi.h>
#include <propidl.h>
#include <propvarutil.h>

#include <atomic>
#include <cstring>
#include <new>

#include "uzjam_apo_ffi.h"

// {7EC11543-6693-43CE-B7DA-50512A736FF8}
DEFINE_GUID(CLSID_UzjamEndpointApo, 0x7ec11543, 0x6693, 0x43ce, 0xb7, 0xda,
            0x50, 0x51, 0x2a, 0x73, 0x6f, 0xf8);
// Settings Framework context, {96ED8048-DDB4-49D9-919C-C37C2A7DD0FB}
DEFINE_GUID(UZJAM_APO_CONTEXT, 0x96ed8048, 0xddb4, 0x49d9, 0x91, 0x9c, 0xc3,
            0x7c, 0x2a, 0x7d, 0xd0, 0xfb);
// Controllable effect id, {0C589CB5-C1DA-49F4-84E1-2A319AC3C6DA}
DEFINE_GUID(UZJAM_EFFECT_ID, 0x0c589cb5, 0xc1da, 0x49f4, 0x84, 0xe1, 0x2a,
            0x31, 0x9a, 0xc3, 0xc6, 0xda);

const PROPERTYKEY PKEY_Uzjam_Profile = {
    {0x96ed8048, 0xddb4, 0x49d9, {0x91, 0x9c, 0xc3, 0x7c, 0x2a, 0x7d, 0xd0, 0xfb}},
    2};

namespace {

constexpr HNSTIME kFixedLatencyHns = 50'000; // 5 ms, fixed for graph lifetime.
std::atomic<long> g_object_count{0};
std::atomic<long> g_server_locks{0};

#pragma warning(push)
#pragma warning(disable : 4815)
const CRegAPOProperties<1> g_registration(
    CLSID_UzjamEndpointApo, L"UZjam Endpoint EQ",
    L"Copyright (c) UZjam", 1, 0, __uuidof(IAudioProcessingObject),
    static_cast<APO_FLAG>(APO_FLAG_DEFAULT), 1, 1, 1, 1,
    DEFAULT_APOREG_MAXINSTANCES);
#pragma warning(pop)

bool PropertyKeyEqual(const PROPERTYKEY &left, const PROPERTYKEY &right) {
    return IsEqualGUID(left.fmtid, right.fmtid) && left.pid == right.pid;
}

UzjamApoProfileConfig DefaultProfile() {
    UzjamApoProfileConfig profile{};
    profile.size = sizeof(profile);
    profile.abi_version = UZJAM_APO_ABI_VERSION;
    // Fail open until the control app publishes a validated profile.
    profile.enabled = 0;
    profile.safety_margin_db = 0.3;
    return profile;
}

class UzjamEndpointApo final : public CBaseAudioProcessingObject,
                               public IAudioSystemEffects3,
                               public IAudioProcessingObjectNotifications {
  public:
    UzjamEndpointApo()
        : CBaseAudioProcessingObject(g_registration), profile_(DefaultProfile()) {
        g_object_count.fetch_add(1, std::memory_order_relaxed);
    }

    ~UzjamEndpointApo() override {
        if (engine_ != nullptr) {
            uzjam_apo_destroy(engine_);
            engine_ = nullptr;
        }
        if (profile_store_ != nullptr) {
            profile_store_->Release();
        }
        if (endpoint_ != nullptr) {
            endpoint_->Release();
        }
        if (effects_changed_event_ != nullptr) {
            CloseHandle(effects_changed_event_);
        }
        g_object_count.fetch_sub(1, std::memory_order_relaxed);
    }

    UzjamEndpointApo(const UzjamEndpointApo &) = delete;
    UzjamEndpointApo &operator=(const UzjamEndpointApo &) = delete;

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void **result) override {
        if (result == nullptr) {
            return E_POINTER;
        }
        *result = nullptr;
        if (iid == __uuidof(IUnknown) || iid == __uuidof(IAudioProcessingObject)) {
            *result = static_cast<IAudioProcessingObject *>(this);
        } else if (iid == __uuidof(IAudioProcessingObjectRT)) {
            *result = static_cast<IAudioProcessingObjectRT *>(this);
        } else if (iid == __uuidof(IAudioProcessingObjectConfiguration)) {
            *result = static_cast<IAudioProcessingObjectConfiguration *>(this);
        } else if (iid == __uuidof(IAudioSystemEffects) ||
                   iid == __uuidof(IAudioSystemEffects2) ||
                   iid == __uuidof(IAudioSystemEffects3)) {
            *result = static_cast<IAudioSystemEffects3 *>(this);
        } else if (iid == __uuidof(IAudioProcessingObjectNotifications)) {
            *result = static_cast<IAudioProcessingObjectNotifications *>(this);
        } else {
            return E_NOINTERFACE;
        }
        AddRef();
        return S_OK;
    }

    ULONG STDMETHODCALLTYPE AddRef() override {
        return reference_count_.fetch_add(1, std::memory_order_relaxed) + 1;
    }

    ULONG STDMETHODCALLTYPE Release() override {
        const ULONG remaining =
            reference_count_.fetch_sub(1, std::memory_order_acq_rel) - 1;
        if (remaining == 0) {
            delete this;
        }
        return remaining;
    }

    HRESULT STDMETHODCALLTYPE Initialize(UINT32 size, BYTE *data) override {
        if ((data == nullptr) != (size == 0)) {
            return E_INVALIDARG;
        }
        if (m_bIsInitialized) {
            return APOERR_ALREADY_INITIALIZED;
        }

        HRESULT status = S_OK;
        if (size == 0) {
            // Used only by the local ABI smoke test. Windows supplies one of
            // the system-effects initialization structures in production.
            m_bIsInitialized = true;
            return S_OK;
        }

        APOInitBaseStruct *base = reinterpret_cast<APOInitBaseStruct *>(data);
        if (size < sizeof(APOInitBaseStruct) ||
            !IsEqualGUID(base->clsid, CLSID_UzjamEndpointApo)) {
            return E_INVALIDARG;
        }

        if (size == sizeof(APOInitSystemEffects3)) {
            auto *init = reinterpret_cast<APOInitSystemEffects3 *>(data);
            status = OpenWindows11UserStore(init);
            if (FAILED(status) && init->pAPOEndpointProperties != nullptr) {
                SetProfileStore(init->pAPOEndpointProperties);
                status = S_OK;
            }
        } else if (size == sizeof(APOInitSystemEffects2)) {
            auto *init = reinterpret_cast<APOInitSystemEffects2 *>(data);
            SetProfileStore(init->pAPOSystemEffectsProperties);
        } else if (size == sizeof(APOInitSystemEffects)) {
            auto *init = reinterpret_cast<APOInitSystemEffects *>(data);
            SetProfileStore(init->pAPOSystemEffectsProperties);
        } else {
            return E_INVALIDARG;
        }

        if (SUCCEEDED(status) && profile_store_ != nullptr) {
            ReadProfile(profile_store_);
        }
        if (SUCCEEDED(status)) {
            m_bIsInitialized = true;
        }
        return status;
    }

    HRESULT STDMETHODCALLTYPE LockForProcess(
        UINT32 input_count, APO_CONNECTION_DESCRIPTOR **inputs,
        UINT32 output_count, APO_CONNECTION_DESCRIPTOR **outputs) override {
        HRESULT status = CBaseAudioProcessingObject::LockForProcess(
            input_count, inputs, output_count, outputs);
        if (FAILED(status)) {
            return status;
        }

        EnterCriticalSection(&m_CritSec);
        if (engine_ != nullptr) {
            uzjam_apo_destroy(engine_);
            engine_ = nullptr;
        }
        const int32_t engine_status =
            [&]() {
                const UzjamApoProfileConfig effective = EffectiveProfile();
                return uzjam_apo_create(GetFramesPerSecond(), GetSamplesPerFrame(),
                                        &effective, &engine_);
            }();
        LeaveCriticalSection(&m_CritSec);
        if (engine_status != UZJAM_APO_OK) {
            CBaseAudioProcessingObject::UnlockForProcess();
            return APOERR_INVALID_CONNECTION_FORMAT;
        }
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE UnlockForProcess() override {
        HRESULT status = CBaseAudioProcessingObject::UnlockForProcess();
        EnterCriticalSection(&m_CritSec);
        if (engine_ != nullptr) {
            uzjam_apo_destroy(engine_);
            engine_ = nullptr;
        }
        LeaveCriticalSection(&m_CritSec);
        return status;
    }

    HRESULT STDMETHODCALLTYPE Reset() override {
        EnterCriticalSection(&m_CritSec);
        if (engine_ != nullptr) {
            UzjamApoHandle *replacement = nullptr;
            const int32_t engine_status =
                [&]() {
                    const UzjamApoProfileConfig effective = EffectiveProfile();
                    return uzjam_apo_create(GetFramesPerSecond(), GetSamplesPerFrame(),
                                            &effective, &replacement);
                }();
            if (engine_status == UZJAM_APO_OK) {
                uzjam_apo_destroy(engine_);
                engine_ = replacement;
            }
        }
        LeaveCriticalSection(&m_CritSec);
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE GetLatency(HNSTIME *latency) override {
        if (latency == nullptr) {
            return E_POINTER;
        }
        *latency = kFixedLatencyHns;
        return S_OK;
    }

#pragma AVRT_CODE_BEGIN
    void STDMETHODCALLTYPE APOProcess(
        UINT32 input_count, APO_CONNECTION_PROPERTY **inputs,
        UINT32 output_count, APO_CONNECTION_PROPERTY **outputs) override {
        if (input_count != 1 || output_count != 1 || inputs == nullptr ||
            outputs == nullptr || inputs[0] == nullptr || outputs[0] == nullptr) {
            return;
        }

        APO_CONNECTION_PROPERTY *input = inputs[0];
        APO_CONNECTION_PROPERTY *output = outputs[0];
        const UINT32 frames = input->u32ValidFrameCount;
        float *output_samples = reinterpret_cast<float *>(output->pBuffer);
        const float *input_samples = reinterpret_cast<const float *>(input->pBuffer);
        const size_t bytes = static_cast<size_t>(frames) * m_u32SamplesPerFrame *
                             sizeof(float);

        if (input->u32BufferFlags == BUFFER_SILENT) {
            ZeroMemory(output_samples, bytes);
            input_samples = output_samples;
        } else if (input->u32BufferFlags != BUFFER_VALID) {
            output->u32ValidFrameCount = 0;
            output->u32BufferFlags = BUFFER_INVALID;
            return;
        }

        const int32_t process_status =
            engine_ == nullptr
                ? UZJAM_APO_ERROR_NULL
                : uzjam_apo_process_f32(engine_, input_samples, output_samples,
                                        frames, m_u32SamplesPerFrame);
        if (process_status != UZJAM_APO_OK && input_samples != output_samples) {
            MoveMemory(output_samples, input_samples, bytes);
        }

        output->u32ValidFrameCount = frames;
        // Even a silent input can release delayed signal or IIR state.
        output->u32BufferFlags = BUFFER_VALID;
    }
#pragma AVRT_CODE_END

    HRESULT STDMETHODCALLTYPE GetEffectsList(GUID **effects, UINT *count,
                                              HANDLE event) override {
        if (effects == nullptr || count == nullptr) {
            return E_POINTER;
        }
        *effects = nullptr;
        *count = 0;
        SaveEffectsChangedEvent(event);
        if (!effect_enabled_.load(std::memory_order_relaxed)) {
            return S_OK;
        }
        GUID *result = static_cast<GUID *>(CoTaskMemAlloc(sizeof(GUID)));
        if (result == nullptr) {
            return E_OUTOFMEMORY;
        }
        result[0] = UZJAM_EFFECT_ID;
        *effects = result;
        *count = 1;
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE GetControllableSystemEffectsList(
        AUDIO_SYSTEMEFFECT **effects, UINT *count, HANDLE event) override {
        if (effects == nullptr || count == nullptr) {
            return E_POINTER;
        }
        *effects = nullptr;
        *count = 0;
        SaveEffectsChangedEvent(event);
        auto *result = static_cast<AUDIO_SYSTEMEFFECT *>(
            CoTaskMemAlloc(sizeof(AUDIO_SYSTEMEFFECT)));
        if (result == nullptr) {
            return E_OUTOFMEMORY;
        }
        result[0] = {UZJAM_EFFECT_ID, TRUE,
                     effect_enabled_.load(std::memory_order_relaxed)
                         ? AUDIO_SYSTEMEFFECT_STATE_ON
                         : AUDIO_SYSTEMEFFECT_STATE_OFF};
        *effects = result;
        *count = 1;
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE SetAudioSystemEffectState(
        GUID effect_id, AUDIO_SYSTEMEFFECT_STATE state) override {
        if (!IsEqualGUID(effect_id, UZJAM_EFFECT_ID)) {
            return E_INVALIDARG;
        }
        effect_enabled_.store(state == AUDIO_SYSTEMEFFECT_STATE_ON,
                              std::memory_order_relaxed);
        StageCurrentProfile();
        if (effects_changed_event_ != nullptr) {
            SetEvent(effects_changed_event_);
        }
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE GetApoNotificationRegistrationInfo(
        APO_NOTIFICATION_DESCRIPTOR **notifications, DWORD *count) override {
        if (notifications == nullptr || count == nullptr) {
            return E_POINTER;
        }
        *notifications = nullptr;
        *count = 0;
        if (endpoint_ == nullptr) {
            return S_OK;
        }
        auto *descriptor = static_cast<APO_NOTIFICATION_DESCRIPTOR *>(
            CoTaskMemAlloc(sizeof(APO_NOTIFICATION_DESCRIPTOR)));
        if (descriptor == nullptr) {
            return E_OUTOFMEMORY;
        }
        ZeroMemory(descriptor, sizeof(*descriptor));
        descriptor->type = APO_NOTIFICATION_TYPE_SYSTEM_EFFECTS_PROPERTY_CHANGE;
        descriptor->audioSystemEffectsPropertyChange.device = endpoint_;
        endpoint_->AddRef();
        descriptor->audioSystemEffectsPropertyChange.propertyStoreContext =
            UZJAM_APO_CONTEXT;
        *notifications = descriptor;
        *count = 1;
        return S_OK;
    }

    void STDMETHODCALLTYPE HandleNotification(
        APO_NOTIFICATION *notification) override {
        if (notification == nullptr ||
            notification->type !=
                APO_NOTIFICATION_TYPE_SYSTEM_EFFECTS_PROPERTY_CHANGE) {
            return;
        }
        const auto &change = notification->audioSystemEffectsPropertyChange;
        if (!IsEqualGUID(change.propertyStoreContext, UZJAM_APO_CONTEXT) ||
            !PropertyKeyEqual(change.propertyKey, PKEY_Uzjam_Profile) ||
            change.propertyStore == nullptr) {
            return;
        }
        ReadProfile(change.propertyStore);
    }

  private:
    HRESULT OpenWindows11UserStore(APOInitSystemEffects3 *init) {
        if (init == nullptr || init->pDeviceCollection == nullptr) {
            return E_INVALIDARG;
        }
        UINT device_count = 0;
        HRESULT status = init->pDeviceCollection->GetCount(&device_count);
        if (FAILED(status) || device_count == 0) {
            return FAILED(status) ? status : E_UNEXPECTED;
        }
        IMMDevice *endpoint = nullptr;
        status = init->pDeviceCollection->Item(device_count - 1, &endpoint);
        if (FAILED(status)) {
            return status;
        }
        if (endpoint_ != nullptr) {
            endpoint_->Release();
        }
        endpoint_ = endpoint;

        PROPVARIANT activation;
        PropVariantInit(&activation);
        status = InitPropVariantFromCLSID(UZJAM_APO_CONTEXT, &activation);
        if (FAILED(status)) {
            return status;
        }
        IAudioSystemEffectsPropertyStore *effects_store = nullptr;
        status = endpoint_->Activate(__uuidof(IAudioSystemEffectsPropertyStore),
                                     CLSCTX_INPROC_SERVER, &activation,
                                     reinterpret_cast<void **>(&effects_store));
        PropVariantClear(&activation);
        if (FAILED(status)) {
            return status;
        }
        IPropertyStore *user_store = nullptr;
        status = effects_store->OpenUserPropertyStore(STGM_READ, &user_store);
        effects_store->Release();
        if (SUCCEEDED(status)) {
            SetProfileStore(user_store);
            user_store->Release();
        }
        return status;
    }

    void SetProfileStore(IPropertyStore *store) {
        if (store != nullptr) {
            store->AddRef();
        }
        if (profile_store_ != nullptr) {
            profile_store_->Release();
        }
        profile_store_ = store;
    }

    void ReadProfile(IPropertyStore *store) {
        PROPVARIANT value;
        PropVariantInit(&value);
        if (SUCCEEDED(store->GetValue(PKEY_Uzjam_Profile, &value)) &&
            value.vt == VT_BLOB &&
            value.blob.cbSize == sizeof(UzjamApoProfileConfig) &&
            value.blob.pBlobData != nullptr) {
            UzjamApoProfileConfig candidate{};
            CopyMemory(&candidate, value.blob.pBlobData, sizeof(candidate));
            if (candidate.size == sizeof(candidate) &&
                candidate.abi_version == UZJAM_APO_ABI_VERSION &&
                candidate.filter_count <= UZJAM_APO_MAX_FILTERS) {
                EnterCriticalSection(&m_CritSec);
                profile_ = candidate;
                if (engine_ != nullptr) {
                    const UzjamApoProfileConfig effective = EffectiveProfile();
                    uzjam_apo_stage_profile(engine_, &effective);
                }
                LeaveCriticalSection(&m_CritSec);
            }
        }
        PropVariantClear(&value);
    }

    UzjamApoProfileConfig EffectiveProfile() const {
        UzjamApoProfileConfig effective = profile_;
        if (!effect_enabled_.load(std::memory_order_relaxed)) {
            effective.enabled = 0;
        }
        return effective;
    }

    void StageCurrentProfile() {
        EnterCriticalSection(&m_CritSec);
        if (engine_ != nullptr) {
            const UzjamApoProfileConfig effective = EffectiveProfile();
            uzjam_apo_stage_profile(engine_, &effective);
        }
        LeaveCriticalSection(&m_CritSec);
    }

    void SaveEffectsChangedEvent(HANDLE event) {
        if (effects_changed_event_ != nullptr) {
            CloseHandle(effects_changed_event_);
            effects_changed_event_ = nullptr;
        }
        if (event != nullptr) {
            DuplicateHandle(GetCurrentProcess(), event, GetCurrentProcess(),
                            &effects_changed_event_, EVENT_MODIFY_STATE, FALSE, 0);
        }
    }

    std::atomic<ULONG> reference_count_{1};
    std::atomic<bool> effect_enabled_{true};
    UzjamApoProfileConfig profile_{};
    UzjamApoHandle *engine_ = nullptr;
    IPropertyStore *profile_store_ = nullptr;
    IMMDevice *endpoint_ = nullptr;
    HANDLE effects_changed_event_ = nullptr;
};

class UzjamClassFactory final : public IClassFactory {
  public:
    UzjamClassFactory() { g_object_count.fetch_add(1, std::memory_order_relaxed); }
    ~UzjamClassFactory() {
        g_object_count.fetch_sub(1, std::memory_order_relaxed);
    }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void **result) override {
        if (result == nullptr) {
            return E_POINTER;
        }
        *result = nullptr;
        if (iid != __uuidof(IUnknown) && iid != __uuidof(IClassFactory)) {
            return E_NOINTERFACE;
        }
        *result = static_cast<IClassFactory *>(this);
        AddRef();
        return S_OK;
    }

    ULONG STDMETHODCALLTYPE AddRef() override {
        return reference_count_.fetch_add(1, std::memory_order_relaxed) + 1;
    }

    ULONG STDMETHODCALLTYPE Release() override {
        const ULONG remaining =
            reference_count_.fetch_sub(1, std::memory_order_acq_rel) - 1;
        if (remaining == 0) {
            delete this;
        }
        return remaining;
    }

    HRESULT STDMETHODCALLTYPE CreateInstance(IUnknown *outer, REFIID iid,
                                             void **result) override {
        if (result == nullptr) {
            return E_POINTER;
        }
        *result = nullptr;
        if (outer != nullptr) {
            return CLASS_E_NOAGGREGATION;
        }
        auto *object = new (std::nothrow) UzjamEndpointApo();
        if (object == nullptr) {
            return E_OUTOFMEMORY;
        }
        const HRESULT status = object->QueryInterface(iid, result);
        object->Release();
        return status;
    }

    HRESULT STDMETHODCALLTYPE LockServer(BOOL lock) override {
        if (lock) {
            g_server_locks.fetch_add(1, std::memory_order_relaxed);
        } else {
            g_server_locks.fetch_sub(1, std::memory_order_relaxed);
        }
        return S_OK;
    }

  private:
    std::atomic<ULONG> reference_count_{1};
};

} // namespace

extern "C" BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(module);
    }
    return TRUE;
}

extern "C" HRESULT __stdcall DllCanUnloadNow() {
    return g_object_count.load(std::memory_order_relaxed) == 0 &&
                   g_server_locks.load(std::memory_order_relaxed) == 0
               ? S_OK
               : S_FALSE;
}

extern "C" HRESULT __stdcall DllGetClassObject(REFCLSID clsid, REFIID iid,
                                                void **result) {
    if (!IsEqualGUID(clsid, CLSID_UzjamEndpointApo)) {
        return CLASS_E_CLASSNOTAVAILABLE;
    }
    auto *factory = new (std::nothrow) UzjamClassFactory();
    if (factory == nullptr) {
        return E_OUTOFMEMORY;
    }
    const HRESULT status = factory->QueryInterface(iid, result);
    factory->Release();
    return status;
}
