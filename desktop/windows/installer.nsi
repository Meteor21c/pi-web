Unicode true
RequestExecutionLevel user
ManifestLongPathAware true
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "WinVer.nsh"
!include "x64.nsh"

Name "MeteorAgent Beta"
OutFile "${APP_INSTALLER}"
InstallDir "$LOCALAPPDATA\Programs\MeteorAgent Beta"
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
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

LangString UnsupportedWindows ${LANG_SIMPCHINESE} "此安装包需要 Windows 10 或 11（x64）。"
LangString UnsupportedWindows ${LANG_ENGLISH} "This installer requires Windows 10 or 11 (x64)."
LangString CloseBeforeInstall ${LANG_SIMPCHINESE} "请先退出 MeteorAgent Beta，再重新运行安装程序。"
LangString CloseBeforeInstall ${LANG_ENGLISH} "Quit MeteorAgent Beta before running the installer again."
LangString InstallFailed ${LANG_SIMPCHINESE} "安装未完成。请检查磁盘空间和文件写入权限后重试。"
LangString InstallFailed ${LANG_ENGLISH} "Installation did not finish. Check available disk space and file permissions, then retry."

Function .onInit
  ${IfNot} ${AtLeastWin10}
  ${OrIfNot} ${IsNativeAMD64}
    MessageBox MB_OK|MB_ICONSTOP "$(UnsupportedWindows)" /SD IDOK
    Abort
  ${EndIf}

  IfFileExists "$INSTDIR\MeteorAgent Beta.exe" 0 ready
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\MeteorAgent Beta.exe", i 0x40000000, i 0, p 0, i 3, i 0x80, p 0) p .r0'
  ${If} $0 = -1
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(CloseBeforeInstall)" /SD IDOK
    Abort
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r0)'
  ready:
FunctionEnd

Section "MeteorAgent Beta"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  ClearErrors
  File /r /x "*.pdb" "${APP_STAGE}/*"
  IfErrors failed
  CreateShortCut "$DESKTOP\MeteorAgent Beta.lnk" "$INSTDIR\MeteorAgent Beta.exe"
  CreateShortCut "$SMPROGRAMS\MeteorAgent Beta.lnk" "$INSTDIR\MeteorAgent Beta.exe"
  IfErrors failed
  Goto done
  failed:
    MessageBox MB_OK|MB_ICONSTOP "$(InstallFailed)" /SD IDOK
    Abort
  done:
SectionEnd
