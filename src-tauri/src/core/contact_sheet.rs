//! R4 Task 2:联系表(contact sheet)PDF 渲染。
//!
//! A4 网格,每张卡片 = JPEG 封面(或灰色占位)+ 三行文字(序号+文件名 /
//! `[入点–出点]` / 章节标题)。CJK 文本走内嵌子集字体(SourceHanSansSC,CFF
//! 内核的 OTF),子集不含的字符由调用方显式替换为「□」并计数——绝不静默丢字。
//!
//! ## printpdf 版本选择:0.12.8,而非任务卡建议的 0.7.x/0.8.x
//!
//! 实测(非纸面判断)排除了 0.7.x:0.7.0 的字体嵌入路径(`font_subsetting`
//! 开或关都一样)硬编码 `FontFile2`/`CIDFontType2`(TrueType glyf 的专属组合),
//! 且**不生成 ToUnicode CMap**——用同一枚 CFF 内核字体渲染中文后,
//! `lopdf::Document::extract_text` 只能吐出乱码,只有 poppler 自己嗅探内嵌
//! cmap 兜底才勉强吐对文本,不可依赖。
//!
//! 0.8.2 用 `allsorts-subset-browser` 正确识别 CFF 轮廓、正确生成
//! `beginbfchar`/`endbfchar` 形式的 ToUnicode CMap,`pdftotext` 与光栅渲染
//! (`pdftoppm`)都验证过是正确的中文——功能上够用,但它绑定的 `lopdf = ^0.35.0`
//! 命中 RUSTSEC-2026-0187(深度嵌套 PDF 对象导致栈溢出,严重度 7.5/high,
//! 官方修复方案是升到 lopdf >=0.42.0),`cargo audit` 会把这判成新增漏洞
//! 拦下(prelaunch 第 5 道门禁跑 `cargo audit`)。0.8.2 本身没有更新的 0.8.x
//! 补丁号可用;往上找,printpdf 0.11.0 起把内部依赖换成了 `lopdf ^0.44.0`
//! (已修复该漏洞),API 也从 `Op::SetFontSize`/`Op::WriteText{font,...}`
//! 演进为 `Op::SetFont{font: PdfFontHandle::External(..), size}` +
//! `Op::ShowText{items}`(字体改成"先 SetFont 设置当前字体,再 ShowText 只带
//! 文本"的隐式关联,不是每次都显式传 `font` 字段了)——本文件按 0.12.8(截至
//! 写这段注释时的最新版,无 yank)的这套新 API 写。选择依据:同一签名族里
//! 挑一个 `cargo audit` 干净、又不是每周都变的版本,而不是死守 brief 举例的
//! 0.7.x/0.8.x——那两个都对我们的 CFF 字体要么不可用(0.7.x)要么带着已知
//! 漏洞的传递依赖(0.8.2)。
//!
//! 0.12.8 依然把该 CFF 字体错标成 `FontFile2`/`CIDFontType2`(poppler 会警告
//! "Mismatch between font type and embedded font file")——这是 printpdf 自身
//! 的已知限制,不是本文件的缺陷;文本抽取(见下方 lopdf 手写 CMap 解析)与
//! 视觉渲染都已验证正确,但不能排除个别严格的 PDF 校验器/打印驱动因这处
//! 类型不匹配拒收。`default-features = false` + `features = ["jpeg"]` 关掉了
//! 默认的 `html` 特性(它会连带拉入 `azul-core`/`azul-layout`/`resvg`/`usvg`/
//! `svg2pdf`/`rust-fontconfig` 等本任务用不到的重依赖)。
//!
//! `lopdf::Document::extract_text`(无论 0.35.0 还是 0.44.0)解析 printpdf
//! 生成的 ToUnicode CMap 都会报 `ToUnicodeCMap(Parse(Error))`(实测排除,不是
//! 猜测)——测试里的文本断言不用这个方法,而是直接用 lopdf 读裸内容流 +
//! 手写的 `beginbfchar` 小解析器(格式简单、我们自己生成,没有必要依赖一个
//! 在我们的用例上已知会报错的高层方法)。同样实测排除了系统 `pdftotext`:
//! 它会把这份 PDF 的字体类型不匹配警告级联成一条按可见间距猜词界的降级抽取
//! 路径,把正常的空格 GID 当排版噪声吞掉(细节见 `extract_visible_text` 的
//! 注释)。

use std::path::Path;
use std::sync::OnceLock;

use printpdf::{
    Color, LinePoint, Mm, Op, PaintMode, ParsedFont, PdfDocument, PdfFontHandle, PdfPage,
    PdfSaveOptions, Point, Polygon, PolygonRing, Pt, RawImage, Rgb, TextItem, WindingOrder,
    XObjectTransform,
};

use super::error::{CoreError, Result};

// 随包 CJK 子集字体(思源黑体 SC 子集,按 OFL 保留字体名条款改名为 TripCut Han Sans SC)。
const FONT_BYTES: &[u8] =
    include_bytes!("../../assets/fonts/TripCutHanSansSC-Regular.otf");

/// 缺字替换符——子集字体不含的字符一律换成这个,并计入
/// [`ContactSheetStats::glyph_fallbacks`],不静默丢弃。
const MISSING_GLYPH_REPLACEMENT: char = '□';

const MM_TO_PT: f32 = 72.0 / 25.4;
const PAGE_MARGIN_MM: f32 = 12.0;
const HEADER_HEIGHT_MM: f32 = 12.0;
const CARD_GAP_MM: f32 = 4.0;
/// 卡片高度中封面图像区域占比,其余留给三行文字。
const IMAGE_HEIGHT_RATIO: f32 = 0.62;
const TEXT_LINE_HEIGHT_MM: f32 = 4.6;
const FONT_SIZE_HEADER_PT: f32 = 13.0;
const FONT_SIZE_LABEL_PT: f32 = 8.0;
const PLACEHOLDER_GRAY: f32 = 0.82;

/// 联系表里的一个片段条目。
pub struct ContactSheetItem {
    pub order: usize,
    pub file_name: String,
    pub in_clock: String,
    pub out_clock: String,
    pub chapter_title: Option<String>,
    pub cover_jpeg: Option<Vec<u8>>,
}

/// 渲染选项。
pub struct ContactSheetOptions {
    pub title: String,
    pub portrait: bool,
    /// 横向 4 / 竖向 3(任务卡约定)。
    pub columns: usize,
}

/// 渲染结果统计。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ContactSheetStats {
    pub pages: usize,
    pub glyph_fallbacks: usize,
    /// R6 Task 7b:封面 JPEG 损坏/截断、解码失败而回退成灰色占位的次数——
    /// 绝不能让单张损坏的封面拖垮整份联系表,但也不能悄悄吞掉这个事实。
    pub cover_failures: usize,
}

fn font_face() -> &'static ttf_parser::Face<'static> {
    static FACE: OnceLock<ttf_parser::Face<'static>> = OnceLock::new();
    FACE.get_or_init(|| {
        ttf_parser::Face::parse(FONT_BYTES, 0).expect("联系表字体子集解析失败——文件已损坏或非法")
    })
}

/// 字体覆盖检查:返回 `text` 中子集字体不含的字符(按原始顺序,可能重复)。
/// 调用方负责把它们替换成「□」并计数——本函数只探测,不做替换。
pub fn missing_glyphs(text: &str) -> Vec<char> {
    let face = font_face();
    text.chars()
        .filter(|c| face.glyph_index(*c).is_none())
        .collect()
}

/// 把 `text` 中子集字体不含的字符替换为 [`MISSING_GLYPH_REPLACEMENT`],
/// 每替换一个就把 `fallbacks` 加一——绝不静默丢弃缺字。
fn sanitize(text: &str, fallbacks: &mut usize) -> String {
    let face = font_face();
    text.chars()
        .map(|c| {
            if face.glyph_index(c).is_some() {
                c
            } else {
                *fallbacks += 1;
                MISSING_GLYPH_REPLACEMENT
            }
        })
        .collect()
}

fn black() -> Color {
    Color::Rgb(Rgb {
        r: 0.0,
        g: 0.0,
        b: 0.0,
        icc_profile: None,
    })
}

fn dark_gray() -> Color {
    Color::Rgb(Rgb {
        r: 0.15,
        g: 0.15,
        b: 0.15,
        icc_profile: None,
    })
}

fn write_line(
    ops: &mut Vec<Op>,
    font_id: &printpdf::FontId,
    text: String,
    x_mm: f32,
    y_mm: f32,
    size_pt: f32,
    color: Color,
) {
    ops.push(Op::StartTextSection);
    ops.push(Op::SetFont {
        font: PdfFontHandle::External(font_id.clone()),
        size: Pt(size_pt),
    });
    ops.push(Op::SetLineHeight { lh: Pt(size_pt) });
    ops.push(Op::SetFillColor { col: color });
    ops.push(Op::SetTextCursor {
        pos: Point::new(Mm(x_mm), Mm(y_mm)),
    });
    ops.push(Op::ShowText {
        items: vec![TextItem::Text(text)],
    });
    ops.push(Op::EndTextSection);
}

fn push_placeholder_rect(ops: &mut Vec<Op>, x_mm: f32, y_mm: f32, w_mm: f32, h_mm: f32) {
    ops.push(Op::SetFillColor {
        col: Color::Rgb(Rgb {
            r: PLACEHOLDER_GRAY,
            g: PLACEHOLDER_GRAY,
            b: PLACEHOLDER_GRAY,
            icc_profile: None,
        }),
    });
    ops.push(Op::DrawPolygon {
        polygon: Polygon {
            rings: vec![PolygonRing {
                points: vec![
                    LinePoint {
                        p: Point::new(Mm(x_mm), Mm(y_mm)),
                        bezier: false,
                    },
                    LinePoint {
                        p: Point::new(Mm(x_mm + w_mm), Mm(y_mm)),
                        bezier: false,
                    },
                    LinePoint {
                        p: Point::new(Mm(x_mm + w_mm), Mm(y_mm + h_mm)),
                        bezier: false,
                    },
                    LinePoint {
                        p: Point::new(Mm(x_mm), Mm(y_mm + h_mm)),
                        bezier: false,
                    },
                ],
            }],
            mode: PaintMode::Fill,
            winding_order: WindingOrder::NonZero,
        },
    });
}

/// 把 JPEG 封面放进 `(x_mm, y_mm)`(左下角)到 `w_mm x h_mm` 的框内,保持长宽比、
/// 居中留白。解码失败时退回灰色占位框(和无封面一致),不让单张坏图炸掉整份联系表。
/// 返回 true 表示封面解码失败(或宽高非法),回退成了灰色占位——调用方据此
/// 累计 [`ContactSheetStats::cover_failures`]。损坏/截断的 JPEG 绝不能让
/// `render_contact_sheet` 整体失败或 panic,只影响这一张卡片。
fn push_cover(
    doc: &mut PdfDocument,
    ops: &mut Vec<Op>,
    jpeg_bytes: &[u8],
    x_mm: f32,
    y_mm: f32,
    w_mm: f32,
    h_mm: f32,
) -> bool {
    // 部分底层 JPEG 解码路径对精心构造的截断/损坏输入是 panic 而不是 Err——
    // 用 catch_unwind 兜底,和 Err 分支一样退化成占位图,不让一张坏封面拖垮
    // 整份联系表(其余卡片、镜头表都还要正常产出)。
    let decoded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut warnings = Vec::new();
        RawImage::decode_from_bytes(jpeg_bytes, &mut warnings)
    }));
    let raw = match decoded {
        Ok(Ok(raw)) => raw,
        Ok(Err(_)) | Err(_) => {
            push_placeholder_rect(ops, x_mm, y_mm, w_mm, h_mm);
            return true;
        }
    };
    let w_px = raw.width as f32;
    let h_px = raw.height as f32;
    if w_px <= 0.0 || h_px <= 0.0 {
        push_placeholder_rect(ops, x_mm, y_mm, w_mm, h_mm);
        return true;
    }
    let image_id = doc.add_image(&raw);
    let box_w_pt = w_mm * MM_TO_PT;
    let box_h_pt = h_mm * MM_TO_PT;
    // dpi = 72 让 1px == 1pt(见 XObjectTransform::get_ctms),这样
    // scale_x/scale_y 直接就是"最终像素边长(pt)= 原始像素数 × scale"。
    let scale = (box_w_pt / w_px).min(box_h_pt / h_px);
    let draw_w_pt = w_px * scale;
    let draw_h_pt = h_px * scale;
    let origin_x_pt = x_mm * MM_TO_PT + (box_w_pt - draw_w_pt) / 2.0;
    let origin_y_pt = y_mm * MM_TO_PT + (box_h_pt - draw_h_pt) / 2.0;
    ops.push(Op::UseXobject {
        id: image_id,
        transform: XObjectTransform {
            translate_x: Some(Pt(origin_x_pt)),
            translate_y: Some(Pt(origin_y_pt)),
            rotate: None,
            scale_x: Some(scale),
            scale_y: Some(scale),
            dpi: Some(72.0),
            ..Default::default()
        },
    });
    false
}

/// 渲染联系表 PDF 到 `out`。空列表返回错误(「没有精选片段」);其余情况下
/// 总是产出至少一页。
pub fn render_contact_sheet(
    items: &[ContactSheetItem],
    options: &ContactSheetOptions,
    out: &Path,
) -> Result<ContactSheetStats> {
    if items.is_empty() {
        return Err(CoreError::ContactSheet("没有精选片段".to_string()));
    }

    let mut font_warnings = Vec::new();
    let font = ParsedFont::from_bytes(FONT_BYTES, 0, &mut font_warnings)
        .ok_or_else(|| CoreError::ContactSheet("联系表字体加载失败".to_string()))?;

    let mut doc = PdfDocument::new(&options.title);
    let font_id = doc.add_font(&font);

    let (page_w_mm, page_h_mm) = if options.portrait {
        (210.0_f32, 297.0_f32)
    } else {
        (297.0_f32, 210.0_f32)
    };
    let columns = options.columns.max(1);
    // 横向 4 列 × 3 行 = 12/页,竖向 3 列 × 4 行 = 12/页——每页固定 12 张卡片。
    let rows = if options.portrait { 4 } else { 3 };
    let per_page = columns * rows;
    let total_pages = items.len().div_ceil(per_page);

    let content_w_mm = page_w_mm - 2.0 * PAGE_MARGIN_MM;
    let content_top_mm = page_h_mm - PAGE_MARGIN_MM - HEADER_HEIGHT_MM;
    let content_h_mm = content_top_mm - PAGE_MARGIN_MM;
    let cell_w_mm = (content_w_mm - CARD_GAP_MM * (columns as f32 - 1.0)) / columns as f32;
    let cell_h_mm = (content_h_mm - CARD_GAP_MM * (rows as f32 - 1.0)) / rows as f32;
    let image_h_mm = cell_h_mm * IMAGE_HEIGHT_RATIO;

    let mut glyph_fallbacks = 0usize;
    let mut cover_failures = 0usize;
    let mut pages = Vec::with_capacity(total_pages);

    for (page_index, chunk) in items.chunks(per_page).enumerate() {
        let mut ops = Vec::new();
        let page_no = page_index + 1;

        let header = sanitize(
            &format!("{} — 第 {}/{} 页", options.title, page_no, total_pages),
            &mut glyph_fallbacks,
        );
        write_line(
            &mut ops,
            &font_id,
            header,
            PAGE_MARGIN_MM,
            page_h_mm - PAGE_MARGIN_MM,
            FONT_SIZE_HEADER_PT,
            black(),
        );

        for (i, item) in chunk.iter().enumerate() {
            let col = i % columns;
            let row = i / columns;
            let cell_x_mm = PAGE_MARGIN_MM + col as f32 * (cell_w_mm + CARD_GAP_MM);
            let cell_top_mm = content_top_mm - row as f32 * (cell_h_mm + CARD_GAP_MM);
            let image_bottom_mm = cell_top_mm - image_h_mm;

            match item.cover_jpeg.as_deref() {
                Some(jpeg_bytes) if !jpeg_bytes.is_empty() => {
                    if push_cover(
                        &mut doc,
                        &mut ops,
                        jpeg_bytes,
                        cell_x_mm,
                        image_bottom_mm,
                        cell_w_mm,
                        image_h_mm,
                    ) {
                        cover_failures += 1;
                    }
                }
                _ => push_placeholder_rect(
                    &mut ops,
                    cell_x_mm,
                    image_bottom_mm,
                    cell_w_mm,
                    image_h_mm,
                ),
            }

            let name_line = sanitize(
                &format!("{:02} {}", item.order, truncate_display_name(&item.file_name)),
                &mut glyph_fallbacks,
            );
            let clock_line = sanitize(
                &format!("[{}\u{2013}{}]", item.in_clock, item.out_clock),
                &mut glyph_fallbacks,
            );
            let chapter_line = item
                .chapter_title
                .as_deref()
                .map(|c| sanitize(c, &mut glyph_fallbacks))
                .unwrap_or_default();

            let mut text_y_mm = image_bottom_mm - TEXT_LINE_HEIGHT_MM * 0.9;
            for line in [name_line, clock_line, chapter_line] {
                if !line.is_empty() {
                    write_line(
                        &mut ops,
                        &font_id,
                        line,
                        cell_x_mm,
                        text_y_mm,
                        FONT_SIZE_LABEL_PT,
                        dark_gray(),
                    );
                }
                text_y_mm -= TEXT_LINE_HEIGHT_MM;
            }
        }

        pages.push(PdfPage::new(Mm(page_w_mm), Mm(page_h_mm), ops));
    }

    let bytes = doc
        .with_pages(pages)
        .save(&PdfSaveOptions::default(), &mut Vec::new());
    std::fs::write(out, &bytes)?;

    Ok(ContactSheetStats {
        pages: total_pages,
        glyph_fallbacks,
        cover_failures,
    })
}

/// R6 Task 7b:卡片上的文件名过长会撑破卡片宽度——中间省略号截断,按字符数
/// (不是字节数,CJK 一字三字节)数"前 12 字…后 8 字"。CSV(`build_shot_list_csv`)
/// 走的是原始 `item.file_name`,不经过这个函数,始终保留全名。
const NAME_TRUNCATE_HEAD_CHARS: usize = 12;
const NAME_TRUNCATE_TAIL_CHARS: usize = 8;

fn truncate_display_name(name: &str) -> String {
    let chars: Vec<char> = name.chars().collect();
    if chars.len() <= NAME_TRUNCATE_HEAD_CHARS + NAME_TRUNCATE_TAIL_CHARS {
        return name.to_string();
    }
    let head: String = chars[..NAME_TRUNCATE_HEAD_CHARS].iter().collect();
    let tail: String = chars[chars.len() - NAME_TRUNCATE_TAIL_CHARS..].iter().collect();
    format!("{head}…{tail}")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::HashMap;

    fn sample_jpeg() -> Vec<u8> {
        // 1x1 红色像素的最小合法 JPEG(用于验证封面路径不炸,不追求画质)。
        const PIXEL: &[u8] = &[
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
            0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43, 0x00, 0x03, 0x02, 0x02,
            0x02, 0x02, 0x02, 0x03, 0x02, 0x02, 0x02, 0x03, 0x03, 0x03, 0x03, 0x04, 0x06, 0x04,
            0x04, 0x04, 0x04, 0x04, 0x08, 0x06, 0x06, 0x05, 0x06, 0x09, 0x08, 0x0A, 0x0A, 0x09,
            0x08, 0x09, 0x09, 0x0A, 0x0C, 0x0F, 0x0C, 0x0A, 0x0B, 0x0E, 0x0B, 0x09, 0x09, 0x0D,
            0x11, 0x0D, 0x0E, 0x0F, 0x10, 0x10, 0x11, 0x10, 0x0A, 0x0C, 0x12, 0x13, 0x12, 0x10,
            0x13, 0x0F, 0x10, 0x10, 0x10, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01,
            0x01, 0x01, 0x11, 0x00, 0xFF, 0xC4, 0x00, 0x1F, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
            0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02,
            0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0xFF, 0xC4, 0x00, 0xB5, 0x10,
            0x00, 0x02, 0x01, 0x03, 0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00,
            0x01, 0x7D, 0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
            0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xA1, 0x08, 0x23, 0x42,
            0xB1, 0xC1, 0x15, 0x52, 0xD1, 0xF0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0A, 0x16,
            0x17, 0x18, 0x19, 0x1A, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2A, 0x34, 0x35, 0x36, 0x37,
            0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x53, 0x54, 0x55,
            0x56, 0x57, 0x58, 0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x73,
            0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
            0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3, 0xA4, 0xA5,
            0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA,
            0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6,
            0xD7, 0xD8, 0xD9, 0xDA, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA,
            0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA, 0xFF, 0xDA, 0x00, 0x08,
            0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0xFB, 0xD0, 0xFF, 0xD9,
        ];
        PIXEL.to_vec()
    }

    fn item(
        order: usize,
        file_name: &str,
        chapter: Option<&str>,
        cover: Option<Vec<u8>>,
    ) -> ContactSheetItem {
        ContactSheetItem {
            order,
            file_name: file_name.to_string(),
            in_clock: "00:00:01:00".to_string(),
            out_clock: "00:00:05:00".to_string(),
            chapter_title: chapter.map(str::to_string),
            cover_jpeg: cover,
        }
    }

    fn tmp_pdf_path(name: &str) -> std::path::PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "tripcut-contact-sheet-{}-{}.pdf",
            name,
            std::process::id()
        ));
        dir
    }

    // ---- lopdf 手写文本抽取(不用 lopdf::Document::extract_text——见文件头注释) ----

    /// printpdf 不是只吐一个大的 `beginbfchar ... endbfchar` 块——实测(0.12.8)
    /// 它按 CID 分组,给每一小撮(常常就是一个字符)各自套一对
    /// `N beginbfchar ... endbfchar`,整份 CMap 里能有十几对。只找“第一对”
    /// 会漏光后面所有块(踩过一次:ASCII 那组在最前面,CJK 全部在后面独立的块
    /// 里,漏了就等于中文全部消失但看不出报错)——这里必须循环找完所有对。
    fn parse_bfchar_pairs(text: &str, map: &mut HashMap<u16, char>) {
        let mut search_from = 0usize;
        while let Some(rel_start) = text[search_from..].find("beginbfchar") {
            let start = search_from + rel_start;
            let Some(rel_end) = text[start..].find("endbfchar") else {
                break;
            };
            let end = start + rel_end;
            let block = &text[start + "beginbfchar".len()..end];
            for line in block.lines() {
                let line = line.trim().trim_matches(|c| c == '<' || c == '>');
                let parts: Vec<&str> = line.split("> <").collect();
                if parts.len() == 2 {
                    if let (Ok(cid), Ok(u)) = (
                        u16::from_str_radix(parts[0], 16),
                        u32::from_str_radix(parts[1], 16),
                    ) {
                        if let Some(ch) = char::from_u32(u) {
                            map.insert(cid, ch);
                        }
                    }
                }
            }
            search_from = end + "endbfchar".len();
        }
    }

    fn push_decoded(out: &mut String, bytes: &[u8], map: &HashMap<u16, char>) {
        for chunk in bytes.as_chunks::<2>().0 {
            let cid = u16::from_be_bytes(*chunk);
            if let Some(c) = map.get(&cid) {
                out.push(*c);
            }
        }
    }

    /// 读出 PDF 里所有可见文字:用 lopdf 直接读裸内容流的 Tj/TJ 操作数,配合我们
    /// 自己解析的 ToUnicode CMap(`beginbfchar`/`endbfchar`)还原 Unicode 文本。
    ///
    /// 没有优先走系统 `pdftotext`——实测过(不是猜测):这份 PDF 因为 printpdf
    /// 0.8.2 的已知限制被 poppler 判定成 "Mismatch between font type and
    /// embedded font file",poppler 会切到一条按可见间距猜词界的降级抽取路径,
    /// 把 "第 1 章" 里两个正常的空格 GID 当成排版噪声吞掉,变成 "第1章"——
    /// 断言会假红,而这不是我们生成的 PDF 有问题(下面直接验证:按同一份
    /// ToUnicode CMap 逐 GID 解码,两个空格原样都在)。lopdf 只做逐字节精确
    /// 解码,没有这层启发式,断言更能反映"内容流里到底编码了什么"。
    pub(crate) fn extract_visible_text(path: &std::path::Path) -> String {
        let doc = lopdf::Document::load(path).expect("lopdf 打开生成的 PDF 失败");

        let mut cmap: HashMap<u16, char> = HashMap::new();
        for object in doc.objects.values() {
            if let lopdf::Object::Stream(stream) = object {
                let bytes = stream
                    .decompressed_content()
                    .unwrap_or_else(|_| stream.content.clone());
                let text = String::from_utf8_lossy(&bytes);
                if text.contains("beginbfchar") {
                    parse_bfchar_pairs(&text, &mut cmap);
                }
            }
        }

        let mut result = String::new();
        for (_, page_id) in doc.get_pages() {
            let content_bytes = doc.get_page_content(page_id);
            let Ok(content) = lopdf::content::Content::decode(&content_bytes) else {
                continue;
            };
            for op in content.operations {
                match op.operator.as_str() {
                    "Tj" => {
                        if let Some(lopdf::Object::String(s, _)) = op.operands.first() {
                            push_decoded(&mut result, s, &cmap);
                        }
                    }
                    "TJ" => {
                        if let Some(lopdf::Object::Array(items)) = op.operands.first() {
                            for it in items {
                                if let lopdf::Object::String(s, _) = it {
                                    push_decoded(&mut result, s, &cmap);
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            result.push('\n');
        }
        result
    }

    #[test]
    fn three_items_one_page_with_cjk_emoji_and_chapter() {
        let items = vec![
            item(1, "旅拍010.mov", Some("第 1 章"), Some(sample_jpeg())),
            item(2, "海边🎬结尾.mov", None, None),
            item(3, "山顶afternoon.mov", Some("尾声"), None),
        ];
        let options = ContactSheetOptions {
            title: "旅剪联系表".to_string(),
            portrait: true,
            columns: 3,
        };
        let out = tmp_pdf_path("three-items");

        let stats = render_contact_sheet(&items, &options, &out).expect("渲染应成功");
        assert_eq!(stats.pages, 1);
        assert!(stats.glyph_fallbacks > 0, "🎬 不在子集里,应计入缺字替换");

        let bytes = std::fs::read(&out).expect("PDF 文件应存在");
        assert!(bytes.starts_with(b"%PDF-"), "应有 %PDF- 头");

        let text = extract_visible_text(&out);
        assert!(text.contains("第 1 章"), "文本流应含章节标题「第 1 章」: {text:?}");
        assert!(
            text.contains("旅拍010.mov"),
            "文本流应含文件名子串「旅拍010.mov」: {text:?}"
        );

        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn thirty_items_landscape_three_pages() {
        let items: Vec<ContactSheetItem> = (1..=30)
            .map(|i| item(i, &format!("clip{i:03}.mov"), None, None))
            .collect();
        let options = ContactSheetOptions {
            title: "旅剪联系表".to_string(),
            portrait: false,
            columns: 4,
        };
        let out = tmp_pdf_path("thirty-items");

        let stats = render_contact_sheet(&items, &options, &out).expect("渲染应成功");
        assert_eq!(stats.pages, 3, "30 条 / 12 每页(4x3)= 3 页");

        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn empty_items_returns_error() {
        let options = ContactSheetOptions {
            title: "空联系表".to_string(),
            portrait: true,
            columns: 3,
        };
        let out = tmp_pdf_path("empty");

        let err = render_contact_sheet(&[], &options, &out).expect_err("空列表应报错");
        assert!(
            matches!(&err, CoreError::ContactSheet(msg) if msg.contains("没有精选片段")),
            "错误信息应包含「没有精选片段」: {err}"
        );
        assert!(!out.exists(), "失败时不应留下半成品文件");
    }

    #[test]
    fn missing_glyphs_reports_emoji_but_not_cjk() {
        let missing = missing_glyphs("旅拍🎬");
        assert!(missing.contains(&'🎬'), "🎬 不在子集里,应被报告缺失");
        assert!(!missing.contains(&'旅'), "「旅」在子集里,不应被报告缺失");
    }

    #[test]
    fn corrupted_cover_falls_back_to_placeholder_without_failing_the_sheet() {
        // 200 字节垃圾数据,只保留合法的 JPEG SOI 标记(0xFFD8)——
        // 损坏/截断封面必须退化成灰色占位,不能拖垮整份联系表,也不能被
        // 悄悄吞掉:render_contact_sheet 仍要 Ok,并如实计入 cover_failures。
        let mut garbage = vec![0xFFu8, 0xD8];
        garbage.extend(std::iter::repeat_n(0x5Au8, 198));

        let items = vec![item(1, "损坏封面.mov", None, Some(garbage))];
        let options = ContactSheetOptions {
            title: "损坏封面测试".to_string(),
            portrait: true,
            columns: 3,
        };
        let out = tmp_pdf_path("corrupted-cover");

        let stats = render_contact_sheet(&items, &options, &out).expect("损坏封面不应让整份渲染失败");
        assert_eq!(stats.pages, 1);
        assert_eq!(stats.cover_failures, 1, "唯一一张封面解码失败,应计入 1");

        let bytes = std::fs::read(&out).expect("PDF 文件应存在");
        assert!(bytes.starts_with(b"%PDF-"), "应有 %PDF- 头");

        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn long_cjk_file_name_is_truncated_with_middle_ellipsis_but_csv_keeps_full_name() {
        // 60 个汉字的文件名——卡片文本流里应看到「前 12 字…后 8 字」的截断形式,
        // 而不是全名(按字符数截断,不是字节数;CJK 一字三字节会把字节版切烂)。
        let long_name: String = "旅".repeat(20) + &"拍".repeat(20) + &"记".repeat(20);
        assert_eq!(long_name.chars().count(), 60);

        let items = vec![item(1, &long_name, None, None)];
        let options = ContactSheetOptions {
            title: "长文件名测试".to_string(),
            portrait: true,
            columns: 3,
        };
        let out = tmp_pdf_path("long-name");

        render_contact_sheet(&items, &options, &out).expect("渲染应成功");

        let text = extract_visible_text(&out);
        let head: String = long_name.chars().take(12).collect();
        let tail: String = long_name.chars().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect();
        let truncated = format!("{head}…{tail}");
        assert!(
            text.contains(&truncated),
            "文本流应含截断形式「{truncated}」: {text:?}"
        );
        assert!(
            !text.contains(&long_name),
            "文本流不应含完整的 60 字全名: {text:?}"
        );

        let _ = std::fs::remove_file(&out);
    }
}
