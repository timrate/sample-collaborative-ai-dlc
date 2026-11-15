// Browser upload to an S3 presigned POST (attachments, CLI workspace imports).
// XMLHttpRequest rather than fetch so callers can show upload progress.
export const postPresignedUpload = (
  upload: { url: string; fields: Record<string, string> },
  body: Blob,
  { label, onProgress }: { label: string; onProgress?: (percent: number) => void },
) =>
  new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', upload.url);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    request.onerror = () => reject(new Error(`Failed to upload ${label}`));
    request.onload = () =>
      request.status >= 200 && request.status < 300
        ? resolve()
        : reject(new Error(`Failed to upload ${label}`));
    const form = new FormData();
    for (const [name, value] of Object.entries(upload.fields)) form.append(name, value);
    form.append('file', body);
    request.send(form);
  });
