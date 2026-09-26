# The Node host is gated until this process owns it in a kill-on-close job.
# A private pipe keeps this handle alive only while the host is alive. Names are
# random per invocation; probing a missing name never targets a reused PID.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ShipJob {
    [StructLayout(LayoutKind.Sequential)] public struct Basic {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public IntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public IntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Io {
        public long ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public long ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Extended {
        public Basic BasicLimitInformation;
        public Io IoInfo;
        public IntPtr ProcessMemoryLimit, JobMemoryLimit;
        public IntPtr PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
}
'@
function Fail($operation) { throw "$operation failed (Win32 $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }
$name = 'Global\Ship-' + $args[1]
if ($args[0] -eq 'probe') {
    $job = [ShipJob]::OpenJobObject(4, $false, $name)
    if ($job -ne [IntPtr]::Zero) {
        [void][ShipJob]::CloseHandle($job)
        [Console]::Out.WriteLine('PRESENT')
    } elseif ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 2) {
        [Console]::Out.WriteLine('ABSENT')
    } else { Fail 'OpenJobObject' }
    exit 0
}
if ($args[0] -ne 'own' -or $args.Count -ne 3) { throw 'Invalid job helper invocation' }
$job = [IntPtr]::Zero
$hostProcess = [IntPtr]::Zero
try {
    $job = [ShipJob]::CreateJobObject([IntPtr]::Zero, $name)
    if ($job -eq [IntPtr]::Zero) { Fail 'CreateJobObject' }
    $limits = New-Object ShipJob+Extended
    $limits.BasicLimitInformation.LimitFlags = 0x2000 # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (-not [ShipJob]::SetInformationJobObject($job, 9, [ref]$limits, [Runtime.InteropServices.Marshal]::SizeOf([type][ShipJob+Extended]))) { Fail 'SetInformationJobObject' }
    # Keep the PROCESS handle across the ACK: PID reuse cannot replace this handle.
    $hostProcess = [ShipJob]::OpenProcess(0x1101, $false, [uint32]::Parse($args[2]))
    if ($hostProcess -eq [IntPtr]::Zero) { Fail 'OpenProcess' }
    [Console]::Out.WriteLine('OPENED')
    if ([Console]::In.ReadLine() -ne 'ACK') { throw 'Host disconnected before assignment' }
    if (-not [ShipJob]::AssignProcessToJobObject($job, $hostProcess)) { Fail 'AssignProcessToJobObject' }
    [Console]::Out.WriteLine('READY')
    # On host exit or an interrupted verification run, EOF closes the job.
    while ($null -ne [Console]::In.ReadLine()) { }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($hostProcess -ne [IntPtr]::Zero) { [void][ShipJob]::CloseHandle($hostProcess) }
    if ($job -ne [IntPtr]::Zero) { [void][ShipJob]::CloseHandle($job) }
}
