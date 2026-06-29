; MirrorCam — регистрация DirectShow-фильтра softcam (виртуальная камера).
; installMode = currentUser, поэтому установщик НЕ элевирован — регистрацию
; запускаем элевированно через глагол runas (появится запрос UAC).
; Регистрируем обе разрядности: x64 (Sysnative) и x86 (SysWOW64),
; чтобы камеру видели и 64-битные, и 32-битные приложения.

!include "x64.nsh"

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Регистрация виртуальной камеры MirrorCam (потребуется подтверждение UAC)..."
  ${If} ${RunningX64}
    ExecShellWait "runas" "$WINDIR\Sysnative\regsvr32.exe" '/s "$INSTDIR\vendor\softcam\softcam-x64.dll"'
    ExecShellWait "runas" "$WINDIR\SysWOW64\regsvr32.exe" '/s "$INSTDIR\vendor\softcam\softcam-x86.dll"'
  ${Else}
    ExecShellWait "runas" "$SYSDIR\regsvr32.exe" '/s "$INSTDIR\vendor\softcam\softcam-x86.dll"'
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Удаление регистрации виртуальной камеры MirrorCam (потребуется подтверждение UAC)..."
  ${If} ${RunningX64}
    ExecShellWait "runas" "$WINDIR\Sysnative\regsvr32.exe" '/u /s "$INSTDIR\vendor\softcam\softcam-x64.dll"'
    ExecShellWait "runas" "$WINDIR\SysWOW64\regsvr32.exe" '/u /s "$INSTDIR\vendor\softcam\softcam-x86.dll"'
  ${Else}
    ExecShellWait "runas" "$SYSDIR\regsvr32.exe" '/u /s "$INSTDIR\vendor\softcam\softcam-x86.dll"'
  ${EndIf}
!macroend
