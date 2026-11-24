const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * PCM frames as bytes, whatever shape the host delivered: the SDK types audioPcm as Uint8Array,
 * but a Uint8List crossing JSON often arrives as number[] or a base64 string. Null when empty or
 * unusable, so a bad frame is dropped instead of reaching the socket as a text message.
 */
export function toPcmBytes(pcm: unknown): Uint8Array | null {
  let bytes: Uint8Array | null = null;
  if (pcm instanceof Uint8Array) bytes = pcm;
  else if (pcm instanceof ArrayBuffer) bytes = new Uint8Array(pcm);
  else if (ArrayBuffer.isView(pcm))
    bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  else if (Array.isArray(pcm)) bytes = Uint8Array.from(pcm as number[]);
  else if (typeof pcm === 'string' && pcm.length % 4 === 0 && BASE64.test(pcm)) {
    const bin = atob(pcm);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  }
  return bytes && bytes.length > 0 ? bytes : null;
}
