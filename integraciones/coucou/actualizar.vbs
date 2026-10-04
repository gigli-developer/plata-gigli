' Lanza actualizar.ps1 sin ninguna ventana. Lo usa la tarea programada "Coucou - actualizar"
' (powershell.exe abre su consola aunque sea un instante; wscript no).
Set fso = CreateObject("Scripting.FileSystemObject")
carpeta = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & carpeta & "\actualizar.ps1""", 0, True
