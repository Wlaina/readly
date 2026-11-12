; Readly 安装包钩子
; - .epub 由 tauri.conf.json 的 fileAssociations 注册为默认打开程序（类 ID：Readly.EPUB）
; - .txt 只加入“打开方式”列表，不抢记事本的默认关联
; - 把便携版在“设置 → 加入右键打开方式”里写的注册项改为指向安装版，避免出现两个 Readly

!macro NSIS_HOOK_POSTINSTALL
  ; .txt 打开方式
  WriteRegStr HKCU "Software\Classes\Readly.txt" "" "文本电子书"
  WriteRegStr HKCU "Software\Classes\Readly.txt\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr HKCU "Software\Classes\Readly.txt\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\.txt\OpenWithProgids" "Readly.txt" ""

  ; 应用本身：出现在“打开方式 → 选择其他应用”里
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".txt" ""
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".epub" ""
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "Readly"

  ; 便携版留下的 Readly.Book：改为指向安装版
  WriteRegStr HKCU "Software\Classes\Readly.Book" "" "电子书"
  WriteRegStr HKCU "Software\Classes\Readly.Book\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr HKCU "Software\Classes\Readly.Book\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  DeleteRegValue HKCU "Software\Classes\.txt\OpenWithProgids" "Readly.Book"
  DeleteRegValue HKCU "Software\Classes\.epub\OpenWithProgids" "Readly.Book"
  DeleteRegValue HKCU "Software\Classes\.epub\OpenWithProgids" "EPUB"

  ; 通知资源管理器刷新图标与关联
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Readly.txt"
  DeleteRegKey HKCU "Software\Classes\Readly.Book"
  DeleteRegValue HKCU "Software\Classes\.txt\OpenWithProgids" "Readly.txt"
  DeleteRegKey HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
