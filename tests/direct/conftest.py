"""Windows compatibility shim for genlayer-test 0.29.2 direct mode."""

import os
import tempfile

from gltest.direct import loader
from gltest.direct.vm import VMContext


def _windows_safe_inject_message_to_fd0(vm):
    try:
        from genlayer.py import calldata
        from genlayer.py.types import Address
    except ImportError:
        return

    sender = Address(vm.sender) if isinstance(vm.sender, bytes) else vm.sender
    contract = Address(vm._contract_address) if isinstance(vm._contract_address, bytes) else vm._contract_address
    origin = Address(vm.origin) if isinstance(vm.origin, bytes) else vm.origin
    encoded = calldata.encode(
        {
            "contract_address": contract,
            "sender_address": sender,
            "origin_address": origin,
            "stack": [],
            "value": vm._value,
            "datetime": vm._datetime,
            "is_init": False,
            "chain_id": vm._chain_id,
            "entry_kind": 0,
            "entry_data": b"",
            "entry_stage_data": None,
        }
    )

    fd, path = tempfile.mkstemp()
    os.write(fd, encoded)
    os.lseek(fd, 0, os.SEEK_SET)
    vm._original_stdin_fd = os.dup(0)
    os.dup2(fd, 0)
    os.close(fd)
    vm._message_temp_paths = getattr(vm, "_message_temp_paths", []) + [path]


_original_cleanup = VMContext._cleanup_after_deactivate


def _cleanup_windows_message_files(self):
    _original_cleanup(self)
    for path in getattr(self, "_message_temp_paths", []):
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
    self._message_temp_paths = []


loader._inject_message_to_fd0 = _windows_safe_inject_message_to_fd0
VMContext._cleanup_after_deactivate = _cleanup_windows_message_files
