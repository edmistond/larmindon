use std::collections::HashSet;

/// Get all available system font family names suitable for CSS font-family
pub fn get_system_fonts() -> Vec<String> {
    let mut fonts = match enumerate_system_fonts() {
        Ok(fonts) => fonts,
        Err(e) => {
            eprintln!("Failed to enumerate system fonts: {}", e);
            get_fallback_fonts()
        }
    };

    // Remove duplicates and sort
    let unique: HashSet<_> = fonts.iter().cloned().collect();
    fonts = unique.into_iter().collect();
    fonts.sort_by_key(|a| a.to_lowercase());

    fonts
}

#[cfg(target_os = "macos")]
fn enumerate_system_fonts() -> Result<Vec<String>, Box<dyn std::error::Error>> {
    use core_text::font_collection::get_family_names;

    let family_names = get_family_names();

    let mut families = HashSet::new();

    for name in family_names.iter() {
        let name_str = name.to_string();
        if !name_str.is_empty() {
            families.insert(name_str);
        }
    }

    Ok(families.into_iter().collect())
}

#[cfg(target_os = "windows")]
fn enumerate_system_fonts() -> Result<Vec<String>, Box<dyn std::error::Error>> {
    use windows::core::{Interface, HSTRING, PCWSTR};
    use windows::Win32::Graphics::DirectWrite::{
        DWriteCreateFactory, IDWriteFactory, IDWriteFontCollection, DWRITE_FACTORY_TYPE_SHARED,
    };

    unsafe {
        let factory: IDWriteFactory =
            DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED).map_err(|e| e.to_string())?;

        let collection: IDWriteFontCollection = factory.GetSystemFontCollection(false)?;

        let family_count = collection.GetFontFamilyCount();
        let mut families = Vec::with_capacity(family_count as usize);

        for i in 0..family_count {
            let font_family = collection.GetFontFamily(i)?;
            let family_names = font_family.GetFamilyNames()?;

            // Get the English locale name (locale index 0 is usually English)
            let name_length = family_names.GetStringLength(0)?;
            let mut name_buffer = vec![0u16; (name_length + 1) as usize];
            family_names.GetString(0, &mut name_buffer)?;

            // Convert to String, trimming the null terminator
            let name = String::from_utf16(&name_buffer[..name_length as usize])
                .map_err(|e| e.to_string())?;

            if !name.is_empty() {
                families.push(name);
            }
        }

        Ok(families)
    }
}

#[cfg(target_os = "linux")]
fn enumerate_system_fonts() -> Result<Vec<String>, Box<dyn std::error::Error>> {
    // Try using fontconfig crate first, fall back to fc-list command
    match enumerate_fontconfig() {
        Ok(fonts) => Ok(fonts),
        Err(_) => enumerate_fc_list(),
    }
}

#[cfg(target_os = "linux")]
fn enumerate_fontconfig() -> Result<Vec<String>, Box<dyn std::error::Error>> {
    use fontconfig::Fontconfig;

    let fc = Fontconfig::new().ok_or("Failed to initialize fontconfig")?;

    // Query all fonts
    let fonts = fc.all_fonts().map_err(|e| e.to_string())?;

    let mut families = HashSet::new();

    for pattern in fonts.iter() {
        if let Ok(Some(family)) = pattern.family() {
            let family_str = family.to_string_lossy().into_owned();
            if !family_str.is_empty() {
                families.insert(family_str);
            }
        }
    }

    Ok(families.into_iter().collect())
}

#[cfg(target_os = "linux")]
fn enumerate_fc_list() -> Result<Vec<String>, Box<dyn std::error::Error>> {
    use std::process::Command;

    // Execute fc-list : family (colon separates output fields, family is the field we want)
    let output = Command::new("fc-list")
        .args([":family"])
        .output()
        .map_err(|e| format!("Failed to run fc-list: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "fc-list failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut families = HashSet::new();

    for line in stdout.lines() {
        let family = line.trim();
        if !family.is_empty() && !family.starts_with("<") {
            // Handle comma-separated font families (e.g., "Arial,Helvetica,sans-serif")
            for part in family.split(',') {
                let part = part.trim();
                if !part.is_empty() {
                    families.insert(part.to_string());
                }
            }
        }
    }

    Ok(families.into_iter().collect())
}

fn get_fallback_fonts() -> Vec<String> {
    vec![
        // Sans-serif
        "Arial".to_string(),
        "Helvetica".to_string(),
        "Verdana".to_string(),
        "Tahoma".to_string(),
        "Trebuchet MS".to_string(),
        "Gill Sans".to_string(),
        "Geneva".to_string(),
        "Lucida Grande".to_string(),
        "Segoe UI".to_string(),
        "Roboto".to_string(),
        "Noto Sans".to_string(),
        "DejaVu Sans".to_string(),
        "Liberation Sans".to_string(),
        "Open Sans".to_string(),
        // Serif
        "Times New Roman".to_string(),
        "Georgia".to_string(),
        "Garamond".to_string(),
        "Palatino".to_string(),
        "Bookman".to_string(),
        "Times".to_string(),
        "DejaVu Serif".to_string(),
        "Liberation Serif".to_string(),
        "Noto Serif".to_string(),
        // Monospace
        "Courier New".to_string(),
        "Courier".to_string(),
        "Lucida Console".to_string(),
        "Monaco".to_string(),
        "Consolas".to_string(),
        "Menlo".to_string(),
        "DejaVu Sans Mono".to_string(),
        "Liberation Mono".to_string(),
        "Noto Mono".to_string(),
        "Roboto Mono".to_string(),
    ]
}
