/** foliate-js 的高亮绘制层（只声明 Readly 用到的部分） */
export declare class Overlayer {
  static highlight(rects: unknown, options?: { color?: string }): SVGElement
  static underline(rects: unknown, options?: { color?: string }): SVGElement
  static outline(rects: unknown, options?: { color?: string }): SVGElement
}
