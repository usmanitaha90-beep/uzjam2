#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use uzjam_audio::{AudioBackend, WasapiBackend};

    let backend = WasapiBackend::new();
    println!("{} output devices:", backend.backend_name());
    for device in backend.output_devices()? {
        println!(
            "{}{} | {} ch | {:?} Hz | id={}",
            if device.is_default { "* " } else { "  " },
            device.name,
            device.max_channels,
            device.supported_sample_rates,
            device.id
        );
    }

    println!("\nCapture and system-loopback sources:");
    for source in backend.audio_sources()? {
        println!(
            "{}{} | {:?} | {} ch | id={}",
            if source.is_default { "* " } else { "  " },
            source.name,
            source.kind,
            source.max_channels,
            source.id
        );
    }
    Ok(())
}

#[cfg(not(windows))]
fn main() {
    eprintln!("The WASAPI probe is available on Windows only.");
}
