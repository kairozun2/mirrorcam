// MirrorCam — вывод в виртуальную камеру через softcam (DirectShow).
// softcam.dll грузится динамически в рантайме (libloading), чтобы приложение
// запускалось даже без DLL и чтобы не зависеть от линковки на этапе сборки.
//
// Контракт с фронтендом:
//   vcam_start(width, height, fps)          — создать камеру
//   vcam_send_frame(width, height, frame)   — frame: RGBA8888 сверху вниз
//   vcam_stop()                             — удалить камеру
//   vcam_status() -> bool                   — подключилось ли приложение-потребитель
//
// Формат softcam (подтверждено по исходникам): кадр пишется memcpy ровно
// width*height*3 байт, BGR24, сверху вниз, плотно (без выравнивания строк).
#![allow(non_snake_case)]

#[cfg(windows)]
mod imp {
    use std::os::raw::c_void;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::os::windows::process::CommandExt;
    use libloading::{Library, Symbol};

    const NO_WINDOW: u32 = 0x0800_0000; // CREATE_NO_WINDOW
    // CLSID фильтра softcam (из исходников DShowSoftcam.cpp)
    const FILTER_CLSID: &str = "{AEF3B972-5FA5-4647-9571-358EB472BC9E}";

    type CreateFn = unsafe extern "C" fn(i32, i32, f32) -> *mut c_void;
    type DeleteFn = unsafe extern "C" fn(*mut c_void);
    type SendFn = unsafe extern "C" fn(*mut c_void, *const c_void);
    type ConnFn = unsafe extern "C" fn(*mut c_void) -> bool;

    struct Backend {
        _lib: Library,
        create: CreateFn,
        delete: DeleteFn,
        send: SendFn,
        conn: ConnFn,
    }

    struct State {
        backend: Backend,
        handle: *mut c_void,
        width: u32,
        height: u32,
        bgr: Vec<u8>,
    }

    // Доступ к указателю/библиотеке всегда сериализован через STATE-мьютекс,
    // кадры отправляются только из одного места — поэтому Send безопасен.
    unsafe impl Send for State {}

    static STATE: Mutex<Option<State>> = Mutex::new(None);

    fn floor4(v: u32) -> u32 {
        let v = v - (v % 4);
        if v < 4 { 4 } else { v }
    }

    fn dll_path() -> PathBuf {
        // Рядом с exe: vendor/softcam/softcam-x64.dll (как кладёт установщик).
        let mut dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_else(|| PathBuf::from("."));
        dir.push("vendor");
        dir.push("softcam");
        dir.push("softcam-x64.dll");
        dir
    }

    fn load_backend() -> Result<Backend, String> {
        let path = dll_path();
        unsafe {
            let lib = Library::new(&path)
                .map_err(|e| format!("Не удалось загрузить {}: {}", path.display(), e))?;
            let create: Symbol<CreateFn> = lib
                .get(b"scCreateCamera\0")
                .map_err(|e| format!("scCreateCamera: {}", e))?;
            let delete: Symbol<DeleteFn> = lib
                .get(b"scDeleteCamera\0")
                .map_err(|e| format!("scDeleteCamera: {}", e))?;
            let send: Symbol<SendFn> = lib
                .get(b"scSendFrame\0")
                .map_err(|e| format!("scSendFrame: {}", e))?;
            let conn: Symbol<ConnFn> = lib
                .get(b"scIsConnected\0")
                .map_err(|e| format!("scIsConnected: {}", e))?;
            let create = *create;
            let delete = *delete;
            let send = *send;
            let conn = *conn;
            Ok(Backend { _lib: lib, create, delete, send, conn })
        }
    }

    pub fn start(width: u32, height: u32, fps: f32) -> Result<(), String> {
        let mut guard = STATE.lock().map_err(|e| e.to_string())?;
        if let Some(s) = guard.take() {
            unsafe { (s.backend.delete)(s.handle) };
        }
        let backend = load_backend()?;
        let w = floor4(width);
        let h = floor4(height);
        let handle = unsafe { (backend.create)(w as i32, h as i32, fps) };
        if handle.is_null() {
            return Err("Не удалось создать виртуальную камеру (возможно, она уже занята другим приложением).".into());
        }
        *guard = Some(State {
            backend,
            handle,
            width: w,
            height: h,
            bgr: vec![0u8; (w as usize) * (h as usize) * 3],
        });
        Ok(())
    }

    pub fn send_frame(width: u32, height: u32, frame: &[u8]) -> Result<(), String> {
        let mut guard = STATE.lock().map_err(|e| e.to_string())?;
        let st = match guard.as_mut() {
            Some(s) => s,
            None => return Ok(()),
        };

        let w = floor4(width);
        let h = floor4(height);
        // Размер изменился — пересоздать камеру.
        if w != st.width || h != st.height {
            unsafe { (st.backend.delete)(st.handle) };
            let handle = unsafe { (st.backend.create)(w as i32, h as i32, 0.0) };
            if handle.is_null() {
                *guard = None;
                return Err("Не удалось пересоздать виртуальную камеру при смене разрешения.".into());
            }
            st.handle = handle;
            st.width = w;
            st.height = h;
            st.bgr = vec![0u8; (w as usize) * (h as usize) * 3];
        }

        let src_w = width as usize;
        let need = src_w * (height as usize) * 4;
        if frame.len() < need {
            return Ok(()); // битый/неполный кадр — пропускаем
        }

        let w = st.width as usize;
        let h = st.height as usize;
        let dst = &mut st.bgr;
        for y in 0..h {
            let src_row = y * src_w * 4;
            let dst_row = y * w * 3;
            for x in 0..w {
                let s = src_row + x * 4;
                let d = dst_row + x * 3;
                // RGBA -> BGR
                dst[d] = frame[s + 2];
                dst[d + 1] = frame[s + 1];
                dst[d + 2] = frame[s];
            }
        }
        unsafe { (st.backend.send)(st.handle, dst.as_ptr() as *const c_void) };
        Ok(())
    }

    pub fn stop() -> Result<(), String> {
        let mut guard = STATE.lock().map_err(|e| e.to_string())?;
        if let Some(s) = guard.take() {
            unsafe { (s.backend.delete)(s.handle) };
        }
        Ok(())
    }

    pub fn status() -> bool {
        let guard = match STATE.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        match guard.as_ref() {
            Some(s) => unsafe { (s.backend.conn)(s.handle) },
            None => false,
        }
    }

    fn exe_dir() -> PathBuf {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_else(|| PathBuf::from("."))
    }

    // Проверяем, зарегистрирован ли DirectShow-фильтр softcam.
    pub fn is_registered() -> bool {
        std::process::Command::new("reg")
            .args(["query", &format!("HKCR\\CLSID\\{}", FILTER_CLSID)])
            .creation_flags(NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    // Регистрация/дерегистрация обеих DLL через regsvr32 с правами админа (UAC).
    pub fn register(unregister: bool) -> Result<(), String> {
        let dir = exe_dir();
        let x64 = dir.join("vendor").join("softcam").join("softcam-x64.dll");
        let x86 = dir.join("vendor").join("softcam").join("softcam-x86.dll");
        if !x64.exists() {
            return Err(format!("Файл камеры не найден: {}", x64.display()));
        }
        let flag = if unregister { "/u /s" } else { "/s" };
        let bat = std::env::temp_dir().join("mirrorcam_vcam.bat");
        let body = format!(
            "@echo off\r\n\"%SystemRoot%\\System32\\regsvr32.exe\" {flag} \"{x64}\"\r\n\"%SystemRoot%\\SysWOW64\\regsvr32.exe\" {flag} \"{x86}\"\r\n",
            flag = flag,
            x64 = x64.display(),
            x86 = x86.display()
        );
        std::fs::write(&bat, body).map_err(|e| e.to_string())?;
        let ps = format!(
            "Start-Process -FilePath \"{}\" -Verb RunAs -WindowStyle Hidden -Wait",
            bat.display()
        );
        let status = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &ps])
            .creation_flags(NO_WINDOW)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("Регистрация отклонена (нужно подтвердить запрос прав администратора).".into());
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn start(_w: u32, _h: u32, _f: f32) -> Result<(), String> {
        Err("Виртуальная камера доступна только на Windows.".into())
    }
    pub fn send_frame(_w: u32, _h: u32, _f: &[u8]) -> Result<(), String> { Ok(()) }
    pub fn stop() -> Result<(), String> { Ok(()) }
    pub fn status() -> bool { false }
}

#[tauri::command]
pub fn vcam_start(width: u32, height: u32, fps: f32) -> Result<(), String> {
    imp::start(width, height, fps)
}

#[tauri::command]
pub fn vcam_send_frame(width: u32, height: u32, frame: Vec<u8>) -> Result<(), String> {
    imp::send_frame(width, height, &frame)
}

#[tauri::command]
pub fn vcam_stop() -> Result<(), String> {
    imp::stop()
}

#[tauri::command]
pub fn vcam_status() -> bool {
    imp::status()
}

#[tauri::command]
pub fn vcam_ensure_registered() -> Result<bool, String> {
    #[cfg(windows)]
    {
        if imp::is_registered() {
            return Ok(true);
        }
        imp::register(false)?;
        Ok(imp::is_registered())
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

#[tauri::command]
pub fn vcam_unregister() -> Result<(), String> {
    #[cfg(windows)]
    {
        return imp::register(true);
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}
