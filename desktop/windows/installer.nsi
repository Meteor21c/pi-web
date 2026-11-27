Unicode true
RequestExecutionLevel user
ManifestLongPathAware true
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "WinVer.nsh"
!include "x64.nsh"

!define APP_INSTALL_KEY "Software\MeteorAgent\DesktopBeta"

Name "MeteorAgent Beta"
OutFile "${APP_INSTALLER}"
InstallDir "$LOCALAPPDATA\Programs\MeteorAgent Beta"
InstallDirRegKey HKCU "${APP_INSTALL_KEY}" "InstallLocation"
Icon "${APP_ICON}"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "FileDescription" "MeteorAgent Beta Setup"
VIAddVersionKey "ProductName" "MeteorAgent Beta"
VIAddVersionKey "CompanyName" "MeteorAgent"
VIAddVersionKey "LegalCopyright" "MeteorAgent contributors"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"

!define MUI_ICON "${APP_ICON}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\MeteorAgent Beta.exe"
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE CheckInstallDirectory
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

LangString UnsupportedWindows ${LANG_SIMPCHINESE} "此安装包需要 Windows 10 或 11（x64）。"
LangString UnsupportedWindows ${LANG_ENGLISH} "This installer requires Windows 10 or 11 (x64)."
LangString CloseBeforeInstall ${LANG_SIMPCHINESE} "无法替换所选目录中的 MeteorAgent Beta。请先退出应用，或选择有写入权限的目录。"
LangString CloseBeforeInstall ${LANG_ENGLISH} "MeteorAgent Beta could not be replaced in the selected folder. Quit the app or choose a folder you can write to."
LangString InstallFailed ${LANG_SIMPCHINESE} "安装未完成。请检查磁盘空间和文件写入权限后重试。"
LangString InstallFailed ${LANG_ENGLISH} "Installation did not finish. Check available disk space and file permissions, then retry."

Function .onInit
  ${IfNot} ${AtLeastWin10}
  ${OrIfNot} ${IsNativeAMD64}
    MessageBox MB_OK|MB_ICONSTOP "$(UnsupportedWindows)" /SD IDOK
    Abort
  ${EndIf}
FunctionEnd

Function CheckInstallDirectory
  IfFileExists "$INSTDIR\MeteorAgent Beta.exe" 0 ready
  Push $0
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\MeteorAgent Beta.exe", i 0x40000000, i 0, p 0, i 3, i 0x80, p 0) p .r0'
  ${If} $0 = -1
    Pop $0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(CloseBeforeInstall)" /SD IDOK
    Abort
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r0)'
  Pop $0
  ready:
FunctionEnd

Section "MeteorAgent Beta"
  SetShellVarContext current
  ; Recheck just before writing. A silent install also reaches this check.
  Call CheckInstallDirectory
  ClearErrors
  SetOutPath "$INSTDIR"
  IfErrors failed
  File /r /x "*.pdb" "${APP_STAGE}/*"
  IfErrors failed
  CreateShortCut "$DESKTOP\MeteorAgent Beta.lnk" "$INSTDIR\MeteorAgent Beta.exe"
  CreateShortCut "$SMPROGRAMS\MeteorAgent Beta.lnk" "$INSTDIR\MeteorAgent Beta.exe"
  IfErrors failed
  WriteRegStr HKCU "${APP_INSTALL_KEY}" "InstallLocation" "$INSTDIR"
  IfErrors failed
  Goto done
  failed:
    MessageBox MB_OK|MB_ICONSTOP "$(InstallFailed)" /SD IDOK
    Abort
  done:
SectionEnd
