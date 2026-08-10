#[cfg(target_os = "windows")]
use std::mem::size_of;

/// Send recognized text to the current focused input by emitting Unicode
/// keyboard events. This avoids mutating the user's clipboard for the MVP.
#[tauri::command]
pub fn send_text_to_focused_window(text: String) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("没有可发送的文本".into());
    }

    #[cfg(target_os = "windows")]
    {
        send_text_windows(&text)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = text;
        Err("当前平台暂不支持系统级语音输入".into())
    }
}

#[cfg(target_os = "windows")]
fn send_text_windows(text: &str) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    let foreground = unsafe { GetForegroundWindow() };
    if foreground.0.is_null() {
        return Err("未检测到可接收输入的前台窗口".into());
    }

    let mut inputs = Vec::with_capacity(text.encode_utf16().count() * 2);
    for unit in text.encode_utf16() {
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: Default::default(),
                    wScan: unit,
                    dwFlags: KEYEVENTF_UNICODE,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        });
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: Default::default(),
                    wScan: unit,
                    dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        });
    }

    if inputs.is_empty() {
        return Err("没有可发送的文本".into());
    }

    let sent = unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) };
    if sent != inputs.len() as u32 {
        return Err("系统输入发送失败，目标窗口可能不支持直接输入".into());
    }

    Ok(())
}
