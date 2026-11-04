import { Inflate } from 'fflate';
import { AppError } from '../contracts/index.ts';

export const FILE_LIMIT = 20 * 1024 * 1024;
export const EXPANDED_LIMIT = 100 * 1024 * 1024;
export const extension = (name: string) => name.split('.').at(-1)?.toLowerCase() ?? '';
export const supported = (name: string) => ['txt','md','markdown','pdf','docx','pptx'].includes(extension(name));
const fail = (text: string): never => { throw new AppError('FILE_ARCHIVE', text); };
export type ZipEntry = { name: string; size: number; compressed: number; start: number; method: number; crc: number };
const table = Uint32Array.from({length:256}, (_, n) => { for(let i=0;i<8;i++) n=n&1 ? 0xedb88320^(n>>>1) : n>>>1; return n; });
export function crc32(data: Uint8Array) { let crc=0xffffffff; for(const b of data) crc=table[(crc^b)&255]^(crc>>>8); return (crc^0xffffffff)>>>0; }

// Read only the central directory first. No archive payload is inflated to list files.
export function zipDirectory(bytes: Uint8Array, office = false): ZipEntry[] {
 const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 let end=bytes.length-22;
 for(;end>=Math.max(0,bytes.length-65557);end--) if(v.getUint32(end,true)===0x06054b50 && end+22+v.getUint16(end+20,true)===bytes.length) break;
 if(end<0 || end<bytes.length-65557) return fail('ZIP 已损坏或缺少目录');
 const count=v.getUint16(end+10,true), length=v.getUint32(end+12,true), offset=v.getUint32(end+16,true);
 if(v.getUint16(end+4,true)||v.getUint16(end+6,true)||v.getUint16(end+8,true)!==count||count===65535||offset+length!==end) return fail('不支持分卷或 ZIP64 压缩包');
 if(count>(office?2000:200)) return fail(office?'Office 内部条目过多':'ZIP 最多允许 200 条');
 const names=new Set<string>(), entries:ZipEntry[]=[];
 let at=offset,total=0,lastEnd=0;
 for(let i=0;i<count;i++) {
  if(at+46>end || v.getUint32(at,true)!==0x02014b50) return fail('ZIP 目录无效');
  const flags=v.getUint16(at+8,true),method=v.getUint16(at+10,true),crc=v.getUint32(at+16,true),compressed=v.getUint32(at+20,true),size=v.getUint32(at+24,true);
  const nl=v.getUint16(at+28,true),extra=v.getUint16(at+30,true),comment=v.getUint16(at+32,true),local=v.getUint32(at+42,true);
  if(at+46+nl+extra+comment>end || local+30>offset) return fail('ZIP 条目越界');
  const raw=bytes.subarray(at+46,at+46+nl);
  let name:string;
  try { name=new TextDecoder(flags&2048?'utf-8':'gb18030',{fatal:true}).decode(raw); } catch { return fail('ZIP 文件名编码无效'); }
  if(!name || name.length>500 || /[\\\x00-\x1f:]/.test(name) || name.startsWith('/') || name.split('/').some(p=>p==='..'||p==='.')) return fail('ZIP 包含不安全的文件路径');
  if(names.has(name.normalize('NFC'))) return fail('ZIP 包含重复文件名');
  names.add(name.normalize('NFC'));
  if(flags&1 || ![0,8].includes(method)) return fail('不支持加密或此压缩算法的 ZIP');
  if(!office && /\.(zip|7z|rar|gz|tar|bz2|xz)$/i.test(name)) return fail('禁止嵌套压缩包，请先在本机解压');
  total+=size;
  if(total>EXPANDED_LIMIT) return fail('ZIP 展开内容超过 100MB');
  if(v.getUint32(local,true)!==0x04034b50 || v.getUint16(local+6,true)!==flags || v.getUint16(local+8,true)!==method) return fail('ZIP 条目与目录不一致');
  const ln=v.getUint16(local+26,true),le=v.getUint16(local+28,true),start=local+30+ln+le;
  if(start+compressed>offset || ln!==nl || raw.some((b,j)=>bytes[local+30+j]!==b)) return fail('ZIP 条目长度或名称不一致');
  if(!(flags&8) && (v.getUint32(local+18,true)!==compressed||v.getUint32(local+22,true)!==size||v.getUint32(local+14,true)!==crc)) return fail('ZIP 条目大小不一致');
  entries.push({name,size,compressed,start,method,crc});
  at+=46+nl+extra+comment;
 }
 if(at!==end) return fail('ZIP 目录长度不一致');
 for(const e of [...entries].sort((a,b)=>a.start-b.start)) { if(e.start<lastEnd) return fail('ZIP 条目重叠'); lastEnd=e.start+e.compressed; }
 return entries;
}

export function extractEntry(bytes: Uint8Array, entry: ZipEntry, limit=FILE_LIMIT): Uint8Array {
 if(entry.size>limit) return fail('展开后的文件超过允许大小');
 let out:Uint8Array;
 const data=bytes.subarray(entry.start,entry.start+entry.compressed);
 if(entry.method===0) out=data.slice();
 else {
  const parts:Uint8Array[]=[];let size=0;
  const inflater=new Inflate((chunk)=>{size+=chunk.length;if(size>entry.size||size>limit)fail('ZIP 实际展开大小超限');parts.push(chunk);});
  for(let pos=0;pos<data.length;pos+=1024) inflater.push(data.subarray(pos,pos+1024),pos+1024>=data.length);
  out=new Uint8Array(size);let at=0;for(const part of parts){out.set(part,at);at+=part.length;}
 }
 if(out.length!==entry.size||crc32(out)!==entry.crc) return fail('ZIP 文件校验失败，内容已损坏');
 return out;
}
