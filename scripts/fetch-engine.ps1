# Fetch the pinned Windows container engine into resources\engine (bundled by electron-builder as
# <resources>\engine). Layout: bin\podman.exe, bin\gvproxy.exe, bin\win-sshproxy.exe, ENGINE_VERSION.
# Every download is verified against the sha256 in scripts/engine-ref BEFORE it is unpacked or copied.
# Dev shortcut: $env:AW_ENGINE_ZIP / $env:AW_ENGINE_GVPROXY use local copies (still checked against the pin).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'resources\engine'

$ref = @{}
foreach ($line in Get-Content (Join-Path $root 'scripts\engine-ref')) {
  if ($line -match '^([A-Z0-9_]+)=(\S+)$') { $ref[$Matches[1]] = $Matches[2] }
}
function Need($k, $re) { if (-not $ref[$k] -or $ref[$k] -notmatch $re) { throw "fetch-engine: bad $k in scripts/engine-ref" } }
Need 'VERSION' '^\d+\.\d+\.\d+$'
Need 'WINDOWS_AMD64_SHA256' '^[0-9a-f]{64}$'
Need 'GVPROXY_VERSION' '^v\d+\.\d+\.\d+$'
Need 'GVPROXY_WINDOWS_SHA256' '^[0-9a-f]{64}$'
Need 'WINDOWS_AMD64_ZIP' '^[A-Za-z0-9._-]+\.zip$'

function Check($file, $want, $what) {
  $got = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLowerInvariant()
  if ($got -ne $want) { throw "fetch-engine: $what checksum mismatch: expected $want, got $got" }
}

$work = Join-Path ([IO.Path]::GetTempPath()) ("aw-engine-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $zip = Join-Path $work 'podman.zip'
  if ($env:AW_ENGINE_ZIP) { Copy-Item $env:AW_ENGINE_ZIP $zip } else {
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/containers/podman/releases/download/v$($ref['VERSION'])/$($ref['WINDOWS_AMD64_ZIP'])" -OutFile $zip
  }
  Check $zip $ref['WINDOWS_AMD64_SHA256'] 'podman zip'

  $gv = Join-Path $work 'gvproxy.exe'
  if ($env:AW_ENGINE_GVPROXY) { Copy-Item $env:AW_ENGINE_GVPROXY $gv } else {
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/containers/gvisor-tap-vsock/releases/download/$($ref['GVPROXY_VERSION'])/gvproxy-windows.exe" -OutFile $gv
  }
  Check $gv $ref['GVPROXY_WINDOWS_SHA256'] 'gvproxy'

  $x = Join-Path $work 'x'
  Expand-Archive -Path $zip -DestinationPath $x
  if (Test-Path $out) { Remove-Item -Recurse -Force $out }
  New-Item -ItemType Directory -Path (Join-Path $out 'bin') | Out-Null
  foreach ($b in 'podman.exe', 'win-sshproxy.exe') {
    $src = Get-ChildItem -Path $x -Recurse -Filter $b | Select-Object -First 1
    if (-not $src) { throw "fetch-engine: missing $b in the zip" }
    Copy-Item $src.FullName (Join-Path $out "bin\$b")
  }
  # The zip's gvproxy.exe is the vulnerable one; ship the pinned release binary instead.
  Copy-Item $gv (Join-Path $out 'bin\gvproxy.exe')

  $v = (& (Join-Path $out 'bin\podman.exe') --version) -join ' '
  if ($v -notmatch [regex]::Escape($ref['VERSION'])) { throw "fetch-engine: bundled podman is not $($ref['VERSION']): $v" }
  Set-Content -Path (Join-Path $out 'ENGINE_VERSION') -Value $ref['VERSION'] -Encoding ascii
  Write-Host "fetch-engine: bundled engine $($ref['VERSION']) at $out"
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
