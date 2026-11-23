/** 书源的统一数据结构 */
export interface SourceBook {
  source: string
  id: string
  title: string
  author: string
  cover: string
  description: string
  tags: string[]
  status: string
  updated: string
}

export interface SourceChapter {
  id: string
  title: string
  /** 章节地址；网站故意弄坏的链接为空，由 prev 找回 */
  url: string
  /** 链接坏掉的章节：上一章的地址和编号，从上一章最后一页的“下一章”找回本章地址 */
  prev?: { url: string; id: string; ref?: SourceChapter }
  /** 所在卷的标题（文库整本文本里，每章开头一行是“卷名 章名”，按它切章） */
  volume?: string
}

export interface SourceVolume {
  id: string
  title: string
  chapters: SourceChapter[]
  /** 这一卷的封面（大图；有的书源目录页上有） */
  cover?: string
}

/** 章节正文：段落文字与插图按顺序排列 */
export type ChapterBlock = { type: 'p'; text: string } | { type: 'img'; src: string }

export interface ChapterContent {
  title: string
  blocks: ChapterBlock[]
}

/** 搜索结果里的一本书（信息可能不全，详情页再补） */
export interface SearchHit {
  source: string
  id: string
  title: string
  author: string
  cover: string
  intro: string
}

/**
 * 搜索的结果：
 * - hits：找到的书
 * - captcha：网站要求先输入图片验证码（data URL），输入后调用 submitCaptcha
 * - needLogin：网站要求登录，打开 loginUrl 让用户自己登录后再搜
 */
export type SearchOutcome = { hits: SearchHit[] } | { captcha: string } | { needLogin: true }

/** 抓取选项：用哪个隐藏网页、怎么取消 */
export interface FetchOptions {
  slot?: number
  signal?: AbortSignal
}

export interface BookSource {
  id: string
  name: string
  home: string
  loginUrl: string
  /** 访问图片时要带的来源页（防盗链） */
  referer: string
  search(keyword: string, signal?: AbortSignal): Promise<SearchOutcome>
  submitCaptcha?(code: string, signal?: AbortSignal): Promise<SearchOutcome>
  /** 从链接或纯数字里认出书号 */
  parseId(input: string): string | null
  getBook(id: string): Promise<SourceBook>
  getVolumes(id: string): Promise<SourceVolume[]>
  getChapter(bookId: string, chapter: SourceChapter, o?: FetchOptions): Promise<ChapterContent>
}
