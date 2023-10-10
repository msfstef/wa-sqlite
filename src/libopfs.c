// Copyright 2023 Roy T. Hashimoto. All Rights Reserved.
#include <sys/time.h>
#include <emscripten.h>
#include <sqlite3.h>
#include <string.h>

// sqlite3_io_methods javascript handlers
// 64-bit integer parameters are passed by pointer.
extern int opfsClose(sqlite3_file* file);
extern int opfsRead(sqlite3_file* file, void* pData, int iAmt, const sqlite3_int64* pOffset);
extern int opfsWrite(sqlite3_file* file, const void* pData, int iAmt, const sqlite3_int64* pOffset);
extern int opfsTruncate(sqlite3_file* file, const sqlite3_int64* pSize);
extern int opfsSync(sqlite3_file* file, int flags);
extern int opfsFileSize(sqlite3_file* file, sqlite3_int64* pSize);
extern int opfsLock(sqlite3_file* file, int flags);
extern int opfsUnlock(sqlite3_file* file, int flags);
extern int opfsCheckReservedLock(sqlite3_file* file, int* pResOut);
extern int opfsFileControl(sqlite3_file* file, int flags, void* pOut);
extern int opfsSectorSize(sqlite3_file* file);
extern int opfsDeviceCharacteristics(sqlite3_file* file);

extern int opfsOpen(sqlite3_vfs* vfs, const char *zName, sqlite3_file* file, int flags, int *pOutFlags);
extern int opfsDelete(sqlite3_vfs* vfs, const char *zName, int syncDir);
extern int opfsAccess(sqlite3_vfs* vfs, const char *zName, int flags, int *pResOut);

// Glue functions to pass 64-bit integers by pointer.
static int xRead(sqlite3_file* file, void* pData, int iAmt, sqlite3_int64 iOffset) {
  return opfsRead(file, pData, iAmt, &iOffset);
}
static int xWrite(sqlite3_file* file, const void* pData, int iAmt, sqlite3_int64 iOffset) {
  return opfsWrite(file, pData, iAmt, &iOffset);
}
static int xTruncate(sqlite3_file* file, sqlite3_int64 size) {
  return opfsTruncate(file, &size);
}
static int xOpen(sqlite3_vfs* vfs, const char* zName, sqlite3_file* file, int flags, int* pOutFlags) {
  static sqlite3_io_methods io_methods = {
    1,
    opfsClose,
    xRead,
    xWrite,
    xTruncate,
    opfsSync,
    opfsFileSize,
    opfsLock,
    opfsUnlock,
    opfsCheckReservedLock,
    opfsFileControl,
    opfsSectorSize,
    opfsDeviceCharacteristics
  };
  file->pMethods = &io_methods;

  return opfsOpen(vfs, zName, file, flags, pOutFlags);
}

static int xFullPathname(sqlite3_vfs* vfs, const char* zName, int nOut, char* zOut) {
  strncpy(zOut, zName, nOut);
  return SQLITE_OK;
}

static int xCurrentTime(sqlite3_vfs* vfs, double* pJulianDay) {
  // UNIX epoch 1/1/1970 is Julian day 2440587.5
  static const sqlite3_int64 unixEpoch = 24405875*(sqlite3_int64)8640000;
  struct timeval sNow;
  gettimeofday(&sNow, 0);
  sqlite3_int64 julianMillis = unixEpoch + 1000*(sqlite3_int64)sNow.tv_sec + sNow.tv_usec/1000;
  *pJulianDay = julianMillis / 86400000.0;
  return SQLITE_OK;
}

void* EMSCRIPTEN_KEEPALIVE getSqliteFree() {
  return sqlite3_free;
}

int main() {
  sqlite3_initialize();

  sqlite3_vfs* vfs = (sqlite3_vfs*)sqlite3_malloc(sizeof(sqlite3_vfs));
  vfs->iVersion = 1;
  vfs->szOsFile = sizeof(sqlite3_file);
  vfs->mxPathname = 1024;
  vfs->pNext = NULL;
  vfs->zName = "opfs";
  vfs->pAppData = NULL;
  vfs->xOpen = xOpen;
  vfs->xDelete = opfsDelete;
  vfs->xAccess = opfsAccess;
  vfs->xFullPathname = xFullPathname;
  vfs->xCurrentTime = xCurrentTime;
  
  // Get remaining functionality from the default VFS.
  sqlite3_vfs* defer = sqlite3_vfs_find(0);
#define COPY_FIELD(NAME) vfs->NAME = defer->NAME
  COPY_FIELD(xDlOpen);
  COPY_FIELD(xDlError);
  COPY_FIELD(xDlSym);
  COPY_FIELD(xDlClose);
  COPY_FIELD(xRandomness);
  COPY_FIELD(xSleep);
  COPY_FIELD(xGetLastError);
#undef COPY_FIELD

  sqlite3_vfs_register(vfs, 0);

  return 0;
}
