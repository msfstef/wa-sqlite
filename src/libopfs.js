// Copyright 2023 Roy T. Hashimoto. All Rights Reserved.

// @ts-ignore
addToLibrary({
  $opfs_support__postset: 'opfs_support();',
  $opfs_support: function() {
    class File {
      constructor(path, flags) {
        this.path = path;
        this.flags = flags;
        this.lockState = 0; // SQLITE_LOCK_NONE
        this.lockRelease = null;
      }
    };
    File.openFiles = new Map();
    File.rootDirectory = navigator.storage.getDirectory();
    File.getPathComponents = async function(path, create) {
      try {
        const [_, directories, filename] = path.match(/[/]?(.*)[/](.*)$/);
        let directoryHandle = await File.rootDirectory;
        for (const directory of directories.split('/')) {
          if (directory) {
            directoryHandle = await directoryHandle.getDirectoryHandle(directory, { create });
          }
        }
        return [directoryHandle, filename];
      } catch (e) {
        return [];
      }
    }
    File.u64 = function(ptr) {
      const index = ptr >> 2;
      return HEAPU32[index] + (HEAPU32[index + 1] * (2**32));
    }

    // @ts-ignore
    opfs_support = function() {
      return { File };
    }
  },

  opfsOpen: async function(_, zName, file, flags, pOutFlags) {
    const path = zName ? UTF8ToString(zName) : `/null_${Math.random().toString(36).slice(2)}`;
    console.log('xOpen', path, file, '0x'+flags.toString(16));
    try {
      // @ts-ignore
      const { File } = opfs_support();
      const f = new File(path, flags);
      const create = !!(flags & 0x4);
      const [directoryHandle, filename] = await File.getPathComponents(f.path, create);
      if (!directoryHandle) return 14; // SQLITE_CANTOPEN

      const fileHandle = await directoryHandle.getFileHandle(filename, { create });
      f.accessHandle = await fileHandle.createSyncAccessHandle({ mode: 'readwrite-unsafe' });
      File.openFiles.set(file, f);

      setValue(pOutFlags, flags, 'i32');
      return 0; // SQLITE_OK
    } catch (e) {
      switch (e.name) {
        case 'NotFoundError':
          return 14; // SQLITE_CANTOPEN
        default:
          return 10; // SQLITE_IOERR
      }
    }
  },
  opfsOpen__deps: ['$opfs_support'],
  opfsOpen__sig: 'ipppip',
  opfsOpen__async: true,

  opfsDelete: async function(_, zName, syncDir) {
    const path = UTF8ToString(zName);
    console.log('xDelete', path, syncDir);

    // @ts-ignore
    const { File } = opfs_support();
    const [directoryHandle, filename] = await File.getPathComponents(path, false);
    await directoryHandle.removeEntry(filename);
    return 0; // SQLITE_OK
  },
  opfsDelete__deps: ['$opfs_support'],
  opfsDelete__sig: 'ippi',
  opfsDelete__async: true,

  opfsAccess: async function(_, zName, flags, pResOut) {
    const path = UTF8ToString(zName);
    console.log('xAccess', path, '0x'+flags.toString(16));

    try {
      // @ts-ignore
      const { File } = opfs_support();
      const [directoryHandle, filename] = await File.getPathComponents(path, false);
      await directoryHandle.getFileHandle(filename);
      setValue(pResOut, 1, 'i32');
    } catch (e) {
      if (e.name === 'NotFoundError') {
        setValue(pResOut, 0, 'i32');
      } else {
        return 10; // SQLITE_IOERR
      }
    }
    return 0; // SQLITE_OK
  },
  opfsAccess__deps: ['$opfs_support'],
  opfsAccess__sig: 'ippip',
  opfsAccess__async: true,

  opfsClose: async function(file) {
    // @ts-ignore
    const { File } = opfs_support();
    const f = File.openFiles.get(file);
    console.log('xClose', f?.path);
    f.accessHandle.close();
    File.openFiles.delete(file);

    if (f.flags & 8) {
      // SQLITE_OPEN_DELETEONCLOSE
      const [directoryHandle, filename] = await File.getPathComponents(f.path, false);
      await directoryHandle.removeEntry(filename);
    }
    return 0; // SQLITE_OK
  },
  opfsClose__deps: ['$opfs_support'],
  opfsClose__sig: 'ip',
  opfsClose__async: true,

  opfsRead: function(file, pData, iAmt, pOffset) {
    // @ts-ignore
    const { File } = opfs_support();
    const f = File.openFiles.get(file);
    const iOffset = File.u64(pOffset);
    console.log('xRead', f?.path, iAmt, iOffset);

    const pDataArray = HEAPU8.subarray(pData, pData + iAmt);
    const nBytes = f.accessHandle.read(pDataArray, { at: iOffset });
    if (nBytes !== iAmt) return 522; // SQLITE_IOERR_SHORT_READ
    return 0; // SQLITE_OK
  },
  opfsRead__deps: ['$opfs_support'],
  opfsRead__sig: 'ippii',

  opfsWrite: function(file, pData, iAmt, pOffset) {
    // @ts-ignore
    const { File } = opfs_support();
    const f = File.openFiles.get(file);
    const iOffset = File.u64(pOffset);
    console.log('xWrite', f?.path, iAmt, iOffset);

    const pDataArray = HEAPU8.subarray(pData, pData + iAmt);
    const nBytes = f.accessHandle.write(pDataArray, { at: iOffset });
    if (nBytes !== iAmt) return 778; // SQLITE_IOERR_WRITE
    return 0; // SQLITE_OK
  },
  opfsWrite__deps: ['$opfs_support'],
  opfsWrite__sig: 'ippii',

  opfsTruncate: function(file, pSize) {
    // @ts-ignore
    const { File } = opfs_support();
    const f = File.openFiles.get(file);
    const iSize = File.u64(pSize);
    console.log('xTruncate', f?.path, iSize);
    
    f.accessHandle.truncate(iSize);
    return 0; // SQLITE_OK
  },
  opfsTruncate__deps: ['$opfs_support'],
  opfsTruncate__sig: 'ipp',

  opfsSync: function(file, flags) {
    // @ts-ignore
    const { File } = opfs_support();
    const f = File.openFiles.get(file);
    console.log('xSync', f?.path, '0x'+flags.toString(16));

    f.accessHandle.flush();
    return 0; // SQLITE_OK
  },
  opfsSync__deps: ['$opfs_support'],
  opfsSync__sig: 'ipi',

  opfsFileSize: function(file, pSize) {
    // @ts-ignore
    const { File } = opfs_support();
    const f = File.openFiles.get(file);
    const dv = new DataView(HEAPU8.buffer, pSize, 8);
    const size = f.accessHandle.getSize();
    dv.setBigInt64(0, BigInt(size), true);
    console.log('xFileSize', f.path, size);
    return 0; // SQLITE_OK
  },
  opfsFileSize__deps: ['$opfs_support'],
  opfsFileSize__sig: 'ipp',

  opfsLock: async function(file, flags) {
    // @ts-ignore
    const { File } = opfs_support();
    const f = File.openFiles.get(file);
    console.log('xLock', f?.path, '0x'+flags.toString(16));

    if (flags && f.lockState === 0) {
      await new Promise(acquired => {
        navigator.locks.request(f.path, lock => {
          acquired();
          return new Promise(releaser => {
            f.lockRelease = releaser;
          });
        });
      });
    }
    f.lockState = flags;

    return 0; // SQLITE_OK
  },
  opfsLock__deps: ['$opfs_support'],
  opfsLock__sig: 'ipi',
  opfsLock__async: true,

  opfsUnlock: function(file, flags) {
    // @ts-ignore
    const { File } = opfs_support();
    const f = File.openFiles.get(file);
    console.log('xUnlock', f?.path, '0x'+flags.toString(16));

    if (!flags && f.lockState !== 0) {
      f.lockRelease();
      f.lockRelease = null;
    }
    f.lockState = flags;

    return 0; // SQLITE_OK
  },
  opfsUnlock__deps: ['$opfs_support'],
  opfsUnlock__sig: 'ipi',

  opfsCheckReservedLock: async function(file, pResOut) {
    // @ts-ignore
    const { File } = opfs_support();
    const f = File.openFiles.get(file);
    console.log('xCheckReservedLock', f?.path);

    setValue(pResOut, 0, 'i32');
    return 0; // SQLITE_OK
  },
  opfsCheckReservedLock__deps: ['$opfs_support'],
  opfsCheckReservedLock__sig: 'ipp',
  opfsCheckReservedLock__async: true,

  opfsFileControl: async function(file, flags, pOut) {
    // @ts-ignore
    const { File } = opfs_support();
    const f = File.openFiles.get(file);
    console.log('xFileControl', f?.path, flags);
    return 12; // SQLITE_NOTFOUND
  },
  opfsFileControl__deps: ['$opfs_support'],
  opfsFileControl__sig: 'ipip',
  opfsFileControl__async: true,

  opfsSectorSize: function(file) {
    // @ts-ignore
    const { File } = opfs_support();
    const f = File.openFiles.get(file);
    console.log('xSectorSize', f?.path);
    return 4096; // SQLITE_OK
  },
  opfsSectorSize__deps: ['$opfs_support'],
  opfsSectorSize__sig: 'ip',

  opfsDeviceCharacteristics: function(file) {
    // @ts-ignore
    const { File } = opfs_support();
    const f = File.openFiles.get(file);
    console.log('xDeviceCharacteristics', f?.path);
    return 2048; // SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN
  },
  opfsDeviceCharacteristics__deps: ['$opfs_support'],
  opfsDeviceCharacteristics__sig: 'ip',

});