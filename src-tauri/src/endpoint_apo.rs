use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectAudioStatus {
    pub supported: bool,
    pub installed: bool,
    pub active: bool,
    pub output_device_id: Option<String>,
    pub status_detail: String,
    pub last_error: Option<String>,
}

#[cfg(not(windows))]
pub fn status(output_device_id: Option<String>) -> Result<DirectAudioStatus, String> {
    Ok(DirectAudioStatus {
        supported: false,
        installed: false,
        active: false,
        output_device_id,
        status_detail: "Direct system audio is available on Windows 11.".to_string(),
        last_error: None,
    })
}

#[cfg(not(windows))]
pub fn apply(
    _profile: uzjam_core::UzjamProfile,
    output_device_id: Option<String>,
) -> Result<DirectAudioStatus, String> {
    status(output_device_id)
}

#[cfg(windows)]
mod windows_impl {
    use super::DirectAudioStatus;
    use std::mem::ManuallyDrop;
    use std::ptr;
    use uzjam_apo_ffi::{config_from_profile, UzjamApoProfileConfig};
    use uzjam_core::UzjamProfile;
    use windows::core::{GUID, HSTRING};
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::Win32::Media::Audio::{
        eMultimedia, eRender, IAudioSystemEffectsPropertyStore, IMMDevice, IMMDeviceEnumerator,
        MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::StructuredStorage::{
        InitPropVariantFromCLSID, PropVariantClear, PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0,
        PROPVARIANT_0_0_0,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, BLOB, CLSCTX_ALL, COINIT_MULTITHREADED,
        STGM_READ, STGM_READWRITE,
    };
    use windows::Win32::System::Variant::{VT_BLOB, VT_LPWSTR, VT_VECTOR};

    const APO_CLSID_TEXT: &str = "7ec11543-6693-43ce-b7da-50512a736ff8";
    const APO_CONTEXT: GUID = GUID::from_u128(0x96ed8048_ddb4_49d9_919c_c37c2a7dd0fb);
    const AUDIO_EFFECTS_PROPERTY_SET: GUID =
        GUID::from_u128(0xd04e05a6_594b_4fb6_a80d_01af5eed7d1d);

    const PROFILE_KEY: PROPERTYKEY = PROPERTYKEY {
        fmtid: APO_CONTEXT,
        pid: 2,
    };
    const LEGACY_MODE_FX_KEY: PROPERTYKEY = PROPERTYKEY {
        fmtid: AUDIO_EFFECTS_PROPERTY_SET,
        pid: 6,
    };
    const COMPOSITE_MODE_FX_KEY: PROPERTYKEY = PROPERTYKEY {
        fmtid: AUDIO_EFFECTS_PROPERTY_SET,
        pid: 14,
    };

    struct ComApartment(bool);

    impl ComApartment {
        fn initialize() -> Result<Self, String> {
            let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            if result.is_ok() {
                Ok(Self(true))
            } else if result.0 == 0x80010106u32 as i32 {
                Ok(Self(false))
            } else {
                Err(format!(
                    "Windows audio services could not initialize: {}",
                    windows::core::Error::from(result)
                ))
            }
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    fn endpoint(output_device_id: Option<&str>) -> Result<IMMDevice, String> {
        let enumerator: IMMDeviceEnumerator = unsafe {
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|error| format!("Windows could not enumerate audio devices: {error}"))?
        };

        match output_device_id.filter(|id| !id.is_empty()) {
            Some(id) => unsafe {
                enumerator
                    .GetDevice(&HSTRING::from(id))
                    .map_err(|error| format!("The selected output device is unavailable: {error}"))
            },
            None => unsafe {
                enumerator
                    .GetDefaultAudioEndpoint(eRender, eMultimedia)
                    .map_err(|error| format!("Windows has no default playback device: {error}"))
            },
        }
    }

    fn effect_store(
        endpoint: &IMMDevice,
        writable: bool,
    ) -> Result<windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore, String> {
        let mut activation = unsafe { InitPropVariantFromCLSID(&APO_CONTEXT) }
            .map_err(|error| format!("The UZjam settings context could not be created: {error}"))?;
        let system_store: Result<IAudioSystemEffectsPropertyStore, _> =
            unsafe { endpoint.Activate(CLSCTX_ALL, Some(&activation)) };
        unsafe {
            let _ = PropVariantClear(&mut activation);
        }
        let system_store = system_store.map_err(|error| {
            format!("The UZjam endpoint component is not attached to this output: {error}")
        })?;
        unsafe {
            system_store
                .OpenUserPropertyStore(if writable {
                    STGM_READWRITE.0
                } else {
                    STGM_READ.0
                })
                .map_err(|error| {
                    format!("The UZjam endpoint settings could not be opened: {error}")
                })
        }
    }

    fn normalize_guid_text(value: &str) -> String {
        value
            .trim()
            .trim_start_matches('{')
            .trim_end_matches('}')
            .to_ascii_lowercase()
    }

    fn property_contains_apo(
        store: &windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore,
        key: &PROPERTYKEY,
    ) -> bool {
        let Ok(mut value) = (unsafe { store.GetValue(key) }) else {
            return false;
        };
        let mut found = false;
        unsafe {
            let inner = &*value.Anonymous.Anonymous;
            if inner.vt == VT_LPWSTR {
                let text = inner.Anonymous.pwszVal;
                if !text.is_null() {
                    found = text
                        .to_string()
                        .map(|value| normalize_guid_text(&value) == APO_CLSID_TEXT)
                        .unwrap_or(false);
                }
            } else if inner.vt.0 == (VT_VECTOR.0 | VT_LPWSTR.0) {
                let values = inner.Anonymous.calpwstr;
                if !values.pElems.is_null() {
                    for index in 0..values.cElems as usize {
                        let text = *values.pElems.add(index);
                        if !text.is_null()
                            && text
                                .to_string()
                                .map(|value| normalize_guid_text(&value) == APO_CLSID_TEXT)
                                .unwrap_or(false)
                        {
                            found = true;
                            break;
                        }
                    }
                }
            }
            let _ = PropVariantClear(&mut value);
        }
        found
    }

    fn component_is_attached(endpoint: &IMMDevice) -> Result<bool, String> {
        let store = unsafe { endpoint.OpenPropertyStore(STGM_READ) }
            .map_err(|error| format!("The output device properties could not be read: {error}"))?;
        Ok(property_contains_apo(&store, &COMPOSITE_MODE_FX_KEY)
            || property_contains_apo(&store, &LEGACY_MODE_FX_KEY))
    }

    fn stored_profile_enabled(
        store: &windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore,
    ) -> bool {
        let Ok(mut value) = (unsafe { store.GetValue(&PROFILE_KEY) }) else {
            return false;
        };
        let mut enabled = false;
        unsafe {
            let inner = &*value.Anonymous.Anonymous;
            if inner.vt == VT_BLOB {
                let blob = inner.Anonymous.blob;
                if blob.cbSize as usize == size_of::<UzjamApoProfileConfig>()
                    && !blob.pBlobData.is_null()
                {
                    let mut config = UzjamApoProfileConfig::default();
                    ptr::copy_nonoverlapping(
                        blob.pBlobData,
                        (&mut config as *mut UzjamApoProfileConfig).cast::<u8>(),
                        size_of::<UzjamApoProfileConfig>(),
                    );
                    enabled = config.enabled != 0;
                }
            }
            let _ = PropVariantClear(&mut value);
        }
        enabled
    }

    fn write_profile(
        store: &windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore,
        config: &UzjamApoProfileConfig,
    ) -> Result<(), String> {
        let raw = PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                    vt: VT_BLOB,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: PROPVARIANT_0_0_0 {
                        blob: BLOB {
                            cbSize: size_of::<UzjamApoProfileConfig>() as u32,
                            pBlobData: (config as *const UzjamApoProfileConfig)
                                .cast::<u8>()
                                .cast_mut(),
                        },
                    },
                }),
            },
        };
        let borrowed = ManuallyDrop::new(raw);
        unsafe {
            store
                .SetValue(&PROFILE_KEY, &*borrowed)
                .and_then(|_| store.Commit())
                .map_err(|error| format!("UZjam could not update this output device: {error}"))
        }
    }

    pub fn status(output_device_id: Option<String>) -> Result<DirectAudioStatus, String> {
        let _apartment = ComApartment::initialize()?;
        let endpoint = endpoint(output_device_id.as_deref())?;
        let installed = component_is_attached(&endpoint)?;
        if !installed {
            return Ok(DirectAudioStatus {
                supported: true,
                installed: false,
                active: false,
                output_device_id,
                status_detail: "Direct processing is not installed for this output device."
                    .to_string(),
                last_error: None,
            });
        }

        match effect_store(&endpoint, false) {
            Ok(store) => {
                let active = stored_profile_enabled(&store);
                Ok(DirectAudioStatus {
                    supported: true,
                    installed: true,
                    active,
                    output_device_id,
                    status_detail: if active {
                        "UZjam is processing all audio sent to this output.".to_string()
                    } else {
                        "The direct component is ready and bypassed.".to_string()
                    },
                    last_error: None,
                })
            }
            Err(error) => Ok(DirectAudioStatus {
                supported: true,
                installed: true,
                active: false,
                output_device_id,
                status_detail: "The direct component is installed but unavailable.".to_string(),
                last_error: Some(error),
            }),
        }
    }

    pub fn apply(
        profile: UzjamProfile,
        output_device_id: Option<String>,
    ) -> Result<DirectAudioStatus, String> {
        let _apartment = ComApartment::initialize()?;
        let endpoint = endpoint(output_device_id.as_deref())?;
        if !component_is_attached(&endpoint)? {
            return Err(
                "Direct processing is not installed for this output device. Use the compatibility route until a signed UZjam endpoint package is installed."
                    .to_string(),
            );
        }
        let config = config_from_profile(&profile).map_err(|_| {
            "The current EQ profile cannot be sent to the audio component.".to_string()
        })?;
        let store = effect_store(&endpoint, true)?;
        write_profile(&store, &config)?;
        Ok(DirectAudioStatus {
            supported: true,
            installed: true,
            active: config.enabled != 0,
            output_device_id,
            status_detail: if config.enabled != 0 {
                "UZjam is processing all audio sent to this output.".to_string()
            } else {
                "The direct component is ready and bypassed.".to_string()
            },
            last_error: None,
        })
    }
}

#[cfg(windows)]
pub use windows_impl::{apply, status};
