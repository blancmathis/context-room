"""No-replace rename: never substitute check-then-os.rename on an occupied path."""
import ctypes
import os
import sys


def exclusive_rename(source, destination):
    library = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'linux' and hasattr(library, 'renameat2'):
        call = library.renameat2
        call.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        result = call(-100, os.fsencode(source), -100, os.fsencode(destination), 1)  # AT_FDCWD; RENAME_NOREPLACE
    elif sys.platform == 'darwin' and hasattr(library, 'renamex_np'):
        call = library.renamex_np
        call.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        result = call(os.fsencode(source), os.fsencode(destination), 0x4)  # RENAME_EXCL
    else:
        raise OSError('This platform lacks the required exclusive rename primitive.')
    if result:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
    for parent in {os.path.dirname(source), os.path.dirname(destination)}:
        fd = os.open(parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('Two exact paths are required.')
        exclusive_rename(sys.argv[1], sys.argv[2])
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
