export interface PreparedAttachmentInput {
  fileName: string;
  mimeType: string;
  contentBase64: string;
}

export interface FolderUploadPayload {
  folderName: string;
  files: Array<{
    relativePath: string;
    mimeType: string;
    contentBase64: string;
  }>;
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const [, base64 = ""] = result.split(",", 2);
      resolve(base64);
    };
    reader.readAsDataURL(file);
  });
}

export async function buildFolderUploadPayload(files: File[]): Promise<FolderUploadPayload | null> {
  if (files.length === 0) {
    return null;
  }

  const firstRelativePath = files[0].webkitRelativePath;
  if (!firstRelativePath) {
    return null;
  }

  const folderName = firstRelativePath.split("/").filter(Boolean)[0] ?? "folder";
  const payloadFiles: FolderUploadPayload["files"] = [];

  for (const file of files) {
    const relativePath = file.webkitRelativePath;
    if (!relativePath) {
      return null;
    }

    const segments = relativePath.split("/").filter(Boolean);
    const relativeSegments = segments[0] === folderName ? segments.slice(1) : segments;
    const normalizedRelativePath = relativeSegments.join("/");
    if (!normalizedRelativePath) {
      continue;
    }

    payloadFiles.push({
      relativePath: normalizedRelativePath,
      mimeType: file.type || "application/octet-stream",
      contentBase64: await fileToBase64(file),
    });
  }

  if (payloadFiles.length === 0) {
    return null;
  }

  return {
    folderName,
    files: payloadFiles,
  };
}
