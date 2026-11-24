/**
 * globals.d.ts: types for Chrome's File System Access features.
 *
 * Purpose: TypeScript's standard DOM library does not yet describe the folder
 *          picker or the permission methods on saved handles.
 * Runtime: This file produces no JavaScript.
 */
export {};

declare global {
  interface FileSystemPermissionOptions {
    mode: "read" | "readwrite";
  }

  interface FileSystemHandle {
    /** Reads the current permission without showing a prompt. */
    queryPermission(options: FileSystemPermissionOptions): Promise<PermissionState>;
    /** Asks the user for permission. Must be called from a user click. */
    requestPermission(options: FileSystemPermissionOptions): Promise<PermissionState>;
  }

  interface DirectoryPickerOptions {
    id?: string;
    mode?: "read" | "readwrite";
  }

  interface Window {
    /** Opens Chrome's folder picker. Must be called from a user click. */
    showDirectoryPicker(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
  }
}
