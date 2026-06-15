import shutil, sys, datetime, os
print("SYS_HEALTH::TIME::" + datetime.datetime.now().isoformat())
for p in [os.path.expanduser("~"), "/"]:
    try:
        usage = shutil.disk_usage(p)
        print(f"SYS_HEALTH::DISK::{p}::total={usage.total}::used={usage.used}::free={usage.free}::percent={usage.used/usage.total*100:.1f}")
    except Exception as e:
        print(f"SYS_HEALTH::DISK::{p}::ERROR::{e}")
mem = {"total": None, "used": None, "available": None}
try:
    import psutil
    vm = psutil.virtual_memory()
    mem = {"total": vm.total, "used": getattr(vm, 'used', vm.total - getattr(vm, 'available', 0)), "available": getattr(vm, 'available', 'NA')}
    print(f"SYS_HEALTH::MEMORY::total={vm.total}::used={mem['used']}::available={mem['available']}")
except Exception as e:
    print(f"SYS_HEALTH::MEMORY::psutil_unavailable::{e}")
try:
    import subprocess
    out = subprocess.check_output(["tasklist"], text=True, stderr=subprocess.STDOUT)
    print(f"SYS_HEALTH::PROCESSES::tasklist_lines={len(out.splitlines())}")
except Exception as e:
    print(f"SYS_HEALTH::PROCESSES::ERROR::{e}")
