"use client";

const MAX_EXTRACT_CHARS = 24_000;

export const SUPPORTED_FILE_ACCEPT = [
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml", ".log", ".html", ".htm", ".docx",
    "text/plain", "text/markdown", "text/csv", "text/tab-separated-values", "application/json",
    "application/xml", "text/xml", "application/x-yaml", "text/yaml", "text/html",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
].join(",");

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "xml", "yaml", "yml", "log", "html", "htm"]);
const TEXT_MIMES = new Set([
    "text/plain", "text/markdown", "text/csv", "text/tab-separated-values", "application/json",
    "application/xml", "text/xml", "application/x-yaml", "text/yaml", "text/html",
]);

export function fileExtension(name: string): string {
    const value = String(name || "").trim().toLowerCase();
    const dot = value.lastIndexOf(".");
    return dot >= 0 ? value.slice(dot + 1) : "";
}

export function isSupportedReadableFile(name: string, mime: string): boolean {
    const ext = fileExtension(name);
    const type = String(mime || "").toLowerCase().split(";")[0].trim();
    if (ext === "docx") return true;
    if (TEXT_EXTENSIONS.has(ext)) return true;
    return TEXT_MIMES.has(type);
}

function decodeBase64(dataUrl: string): Uint8Array {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) throw new Error("文件数据无效");
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function decodeEntities(value: string): string {
    return value
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function stripHtml(value: string): string {
    return decodeEntities(value
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " "))
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

async function extractDocx(dataUrl: string): Promise<string> {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(decodeBase64(dataUrl));
    const entry = zip.file("word/document.xml");
    if (!entry) throw new Error("docx 里没有正文");
    const xml = await entry.async("string");
    const paragraphs = xml.match(/<w:p[\s\S]*?<\/w:p>/g) || [xml];
    const text = paragraphs.map(paragraph => {
        const withBreaks = paragraph
            .replace(/<w:tab\/>/g, "\t")
            .replace(/<w:br\/>/g, "\n")
            .replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g, "$1");
        return decodeEntities(withBreaks.replace(/<[^>]+>/g, "")).trim();
    }).filter(Boolean).join("\n");
    return text.trim();
}

export async function extractReadableFileText(fileName: string, mime: string, dataUrl: string): Promise<{ text: string; truncated: boolean } | null> {
    if (!isSupportedReadableFile(fileName, mime)) return null;
    const ext = fileExtension(fileName);
    let text = "";
    if (ext === "docx") {
        text = await extractDocx(dataUrl);
    } else {
        const decoded = new TextDecoder("utf-8", { fatal: false }).decode(decodeBase64(dataUrl));
        text = String(decoded || "").replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim();
        if (ext === "json" || String(mime).includes("json")) {
            try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep raw */ }
        } else if (ext === "html" || ext === "htm" || String(mime).includes("html")) {
            text = stripHtml(text);
        }
    }
    const truncated = text.length > MAX_EXTRACT_CHARS;
    return { text: truncated ? `${text.slice(0, MAX_EXTRACT_CHARS)}\n\n…（文件较长，只读取了前 ${MAX_EXTRACT_CHARS} 字）` : text, truncated };
}
