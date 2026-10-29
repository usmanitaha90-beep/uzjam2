[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$EndpointName = "TOPPING USB DAC",
  [string]$EndpointId,
  [switch]$SkipBoom,
  [switch]$Restore
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ($env:OS -ne "Windows_NT") {
  throw "This helper only supports Windows."
}

if (-not ("UzjamEndpointEffects" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[ComImport]
[Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
internal class MMDeviceEnumeratorComObject {}

[ComImport]
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDeviceEnumerator
{
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, uint stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
}

[ComImport]
[Guid("D666063F-1587-4E43-81F1-B948E807363F")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDevice
{
    [PreserveSig] int Activate(ref Guid iid, uint clsctx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    [PreserveSig] int OpenPropertyStore(uint access, out IPropertyStore properties);
    [PreserveSig] int GetId(out IntPtr id);
    [PreserveSig] int GetState(out uint state);
}

[ComImport]
[Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IPropertyStore
{
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PROPERTYKEY key);
    [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
    [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
    [PreserveSig] int Commit();
}

[StructLayout(LayoutKind.Sequential)]
internal struct PROPERTYKEY
{
    public Guid fmtid;
    public uint pid;
}

[StructLayout(LayoutKind.Explicit)]
internal struct PROPVARIANT
{
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public uint ulVal;
}

public static class UzjamEndpointEffects
{
    private const uint STGM_READWRITE = 2;
    private const ushort VT_UI4 = 19;

    private static void Check(int result, string operation)
    {
        if (result < 0) throw new COMException(operation + " failed", result);
    }

    public static uint SetDisabled(string endpointId, bool disabled)
    {
        IMMDeviceEnumerator enumerator = null;
        IMMDevice device = null;
        IPropertyStore store = null;
        try
        {
            enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            Check(enumerator.GetDevice(endpointId, out device), "GetDevice");
            Check(device.OpenPropertyStore(STGM_READWRITE, out store), "OpenPropertyStore");

            var key = new PROPERTYKEY {
                fmtid = new Guid("1DA5D803-D492-4EDD-8C23-E0C0FFEE7F0E"),
                pid = 5
            };
            var value = new PROPVARIANT {
                vt = VT_UI4,
                ulVal = disabled ? 1u : 0u
            };
            Check(store.SetValue(ref key, ref value), "SetValue");
            Check(store.Commit(), "Commit");

            PROPVARIANT current;
            Check(store.GetValue(ref key, out current), "GetValue");
            if (current.vt != VT_UI4) {
                throw new InvalidOperationException("Unexpected property type: " + current.vt);
            }
            return current.ulVal;
        }
        finally
        {
            if (store != null) Marshal.FinalReleaseComObject(store);
            if (device != null) Marshal.FinalReleaseComObject(device);
            if (enumerator != null) Marshal.FinalReleaseComObject(enumerator);
        }
    }
}
"@
}

function Resolve-RenderEndpoint {
  param(
    [string]$RequestedName,
    [string]$RequestedId
  )

  $renderRoot = "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render"
  $endpointLabelProperty = "{a45c254e-df1c-4efd-8020-67d146a850e0},2"
  $deviceNameProperty = "{b3f8fa53-0004-438e-9003-51a46e139bfc},6"
  $endpoints = @(
    Get-ChildItem -LiteralPath $renderRoot | ForEach-Object {
      $endpointState = (Get-ItemProperty -LiteralPath $_.PSPath -Name "DeviceState" -ErrorAction SilentlyContinue).DeviceState
      $propertiesPath = Join-Path $_.PSPath "Properties"
      $properties = Get-ItemProperty -LiteralPath $propertiesPath -ErrorAction SilentlyContinue
      if ($null -eq $properties) { return }
      $endpointLabel = [string]$properties.$endpointLabelProperty
      $deviceName = [string]$properties.$deviceNameProperty
      $displayName = if ($endpointLabel -and $deviceName) {
        "$endpointLabel ($deviceName)"
      }
      elseif ($deviceName) {
        $deviceName
      }
      else {
        $endpointLabel
      }
      [pscustomobject]@{
        Id = "{0.0.0.00000000}.$($_.PSChildName)"
        Name = $displayName
        Active = $endpointState -eq 1
      }
    }
  )

  if (-not [string]::IsNullOrWhiteSpace($RequestedId)) {
    $matches = @($endpoints | Where-Object { $_.Id -eq $RequestedId })
  }
  else {
    $matches = @($endpoints | Where-Object { $_.Active -and $_.Name -like "*$RequestedName*" })
  }

  if ($matches.Count -eq 0) {
    $available = ($endpoints | Where-Object { $_.Active -and $_.Name } | ForEach-Object { "  - $($_.Name)" }) -join "`n"
    throw "No render endpoint matched '$RequestedName$RequestedId'. Available endpoints:`n$available"
  }
  if ($matches.Count -gt 1) {
    $ambiguous = ($matches | ForEach-Object { "  - $($_.Name): $($_.Id)" }) -join "`n"
    throw "More than one endpoint matched. Run again with -EndpointId:`n$ambiguous"
  }

  return $matches[0]
}

function Set-BoomState {
  param([bool]$Enabled)

  $changedTasks = @()
  $packages = @(Get-AppxPackage | Where-Object {
      $_.Name -match "Boom" -or $_.PackageFamilyName -match "Boom"
    })

  foreach ($package in $packages) {
    $systemAppData = "Registry::HKEY_CURRENT_USER\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\SystemAppData\$($package.PackageFamilyName)"
    if (-not (Test-Path -LiteralPath $systemAppData)) { continue }

    foreach ($taskKey in Get-ChildItem -LiteralPath $systemAppData -ErrorAction SilentlyContinue) {
      $task = Get-ItemProperty -LiteralPath $taskKey.PSPath -ErrorAction SilentlyContinue
      if ($null -eq $task -or -not ($task.PSObject.Properties.Name -contains "State")) { continue }

      $desiredState = if ($Enabled) { 2 } else { 1 }
      if ($task.State -ne $desiredState) {
        Set-ItemProperty -LiteralPath $taskKey.PSPath -Name "State" -Type DWord -Value $desiredState
      }
      $changedTasks += [pscustomobject]@{
        Task = $taskKey.PSChildName
        State = $desiredState
      }
    }
  }

  if (-not $Enabled) {
    Get-Process -Name "Boom3D" -ErrorAction SilentlyContinue | Stop-Process -Force
  }

  return $changedTasks
}

function Get-SpatialAudioState {
  param([Parameter(Mandatory = $true)][string]$DeviceId)

  $escapedDeviceId = $DeviceId.Replace("'", "''")
  $probe = @"
`$ErrorActionPreference = 'Stop'
`$ProgressPreference = 'SilentlyContinue'
`$spatialType = [Windows.Media.Audio.SpatialAudioDeviceConfiguration, Windows.Media.Audio, ContentType=WindowsRuntime]
`$configuration = `$spatialType::GetForDeviceId('$escapedDeviceId')
[pscustomobject]@{
  Supported = `$configuration.IsSpatialAudioSupported
  ActiveFormat = `$configuration.ActiveSpatialAudioFormat
  DefaultFormat = `$configuration.DefaultSpatialAudioFormat
} | ConvertTo-Json -Compress
"@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($probe))
  $json = & powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand $encoded 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($json)) {
    return [pscustomobject]@{
      Supported = $null
      ActiveFormat = $null
      DefaultFormat = $null
      Off = $null
    }
  }

  $state = $json | ConvertFrom-Json
  $zeroFormat = "{00000000-0000-0000-0000-000000000000}"
  return [pscustomobject]@{
    Supported = [bool]$state.Supported
    ActiveFormat = [string]$state.ActiveFormat
    DefaultFormat = [string]$state.DefaultFormat
    Off = $state.ActiveFormat -eq $zeroFormat -and $state.DefaultFormat -eq $zeroFormat
  }
}

$endpoint = Resolve-RenderEndpoint -RequestedName $EndpointName -RequestedId $EndpointId
$disableSystemEffects = -not $Restore

if ($PSCmdlet.ShouldProcess($endpoint.Name, "Set Windows system effects disabled=$disableSystemEffects")) {
  $systemEffectsValue = [UzjamEndpointEffects]::SetDisabled($endpoint.Id, $disableSystemEffects)
}

$boomTasks = @()
if (-not $SkipBoom -and $PSCmdlet.ShouldProcess("Boom 3D", $(if ($Restore) { "Enable startup" } else { "Disable startup and stop" }))) {
  $boomTasks = @(Set-BoomState -Enabled:$Restore)
}

$spatial = Get-SpatialAudioState -DeviceId $endpoint.Id
if ($spatial.Off -eq $false) {
  Write-Warning "Spatial Audio is active on '$($endpoint.Name)'. Set Spatial sound to Off in Windows Settings before listening through UZjam."
}

[pscustomobject]@{
  Endpoint = $endpoint.Name
  EndpointId = $endpoint.Id
  SystemEffectsDisabled = $systemEffectsValue -eq 1
  SpatialAudioSupported = $spatial.Supported
  SpatialAudioOff = $spatial.Off
  BoomStartupTasks = $boomTasks
  BoomRunning = [bool](@(Get-Process -Name "Boom3D" -ErrorAction SilentlyContinue).Count)
  Mode = if ($Restore) { "restored" } else { "clean-audio" }
}
