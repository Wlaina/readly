export type Format = 'epub' | 'txt'

export interface Progress {
  cfi: string
  fraction: number
  chapter?: string
  updatedAt: number
}

export interface Bookmark {
  id: string
  cfi: string
  label: string
  text: string
  fraction: number
  createdAt: number
  updatedAt: number
  deleted?: boolean
}

/** 高亮与笔记：按 id 合并，较新的修改胜出；删除用 deleted 标记以便同步到其他设备 */
export type HighlightColor = 'yellow' | 'orange' | 'green' | 'blue' | 'pink'
export interface Annotation {
  id: string
  cfi: string
  /** 选中的原文 */
  text: string
  color: HighlightColor
  /** 笔记（可为空，只有高亮） */
  note?: string
  /** 所在章节名，列表里展示用 */
  chapter?: string
  fraction: number
  createdAt: number
  updatedAt: number
  deleted?: boolean
}

/** 某台设备在一本书上的累计阅读时长（毫秒），只增不减，合并时取较大值 */
export interface ReadStat {
  ms: number
  /** 按天累计：YYYY-MM-DD -> 毫秒 */
  days: Record<string, number>
  device: string
}

/** 书架分类：按 id 合并，较新的修改胜出；删除用 deleted 标记以便同步到其他设备 */
export interface Category {
  id: string
  name: string
  /** 排列顺序，小的在前 */
  order: number
  updatedAt: number
  deleted?: boolean
}

export interface BookRecord {
  /** 文件内容 SHA-256 前 32 位，跨设备唯一标识 */
  hash: string
  title: string
  author: string
  format: Format
  fileName: string
  size: number
  addedAt: number
  /** 标题、作者、删除状态等元数据的修改时间（LWW） */
  metaUpdatedAt: number
  deletedAt?: number
  progress?: Progress
  bookmarks: Bookmark[]
  /** 高亮与笔记（旧数据可能没有） */
  annotations?: Annotation[]
  /** 设备 id -> 阅读时长 */
  readStats?: Record<string, ReadStat>
  /** 清除统计的时间：合并时丢弃此前的统计，让清除在所有设备上生效 */
  statsClearedAt?: number
  lastReadAt?: number
  /** 这本书所属的分类 id（可以属于多个） */
  categories?: string[]
  /** 分类归属的修改时间（LWW，同步时较新的一方胜出） */
  catsAt?: number
  /** 本机是否有书籍文件（同步下来的记录可能只有进度没有文件） */
  hasFile: boolean
  hasCover: boolean
  /** 已尝试从文件提取过封面（本机字段，不同步） */
  coverChecked?: boolean
  /** 封面版本（本机字段）：封面更新时变化，书架据此重新加载 */
  coverRev?: number
  /** 书籍文件版本：编辑书籍信息或文件夹里的文件被修改时更新（同步） */
  fileRev?: number
  /** 本机文件对应的版本（本机字段）；小于 fileRev 时需要重新下载 */
  fileRevLocal?: number
  /** 本机修改了书籍文件，等待上传（本机字段） */
  pendingUpload?: boolean
  /** 来自哪个书籍文件夹的哪个文件（本机字段），用于把编辑写回原文件 */
  folderRef?: { folderId: string; rel: string }
  /** 仅本机阅读，不参与任何云同步 */
  localOnly?: boolean
  /** 书籍文件在 WebDAV 上的位置（手动放入云端目录的书），缺省为 files/<hash>.<ext> */
  remotePath?: string
  /** 任何字段变化时更新；大于 syncedAt 即视为待上传 */
  updatedAt: number
  syncedAt?: number
}

export interface CustomFont {
  id: string
  name: string
  fileName: string
  ext: string
}
