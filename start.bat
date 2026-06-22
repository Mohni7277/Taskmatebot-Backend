@echo off
set "PATH=%PATH%;%~dp0\node_modules\.bin"
tsx src\index.ts
