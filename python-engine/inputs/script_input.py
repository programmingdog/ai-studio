import os
import re
import zipfile
from typing import Any, Dict
from xml.etree import ElementTree


def read_script(params: Dict[str, Any]) -> str:
    pasted = str(params.get("script_text") or "").strip()
    if pasted:
        return normalize(pasted)

    path = os.path.abspath(str(params.get("script_path") or ""))
    if not path or not os.path.isfile(path):
        raise ValueError("script_text or an existing script_path is required")
    extension = os.path.splitext(path)[1].lower()
    if extension in (".txt", ".md"):
        return normalize(_read_text(path))
    if extension == ".docx":
        return normalize(_read_docx(path))
    if extension == ".pdf":
        return normalize(_read_pdf(path))
    raise ValueError("unsupported script file type: {0}".format(extension or "unknown"))


def normalize(text: str) -> str:
    value = text.replace("\r\n", "\n").replace("\r", "\n").replace("\u3000", " ")
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n{3,}", "\n\n", value).strip()
    if len(value) < 10:
        raise ValueError("script must contain at least 10 characters")
    if len(value) > 2_000_000:
        raise ValueError("script exceeds the 2,000,000 character limit")
    return value


def _read_text(path: str) -> str:
    with open(path, "rb") as source:
        content = source.read()
    for encoding in ("utf-8-sig", "gb18030", "utf-16"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError("unable to detect TXT/MD encoding")


def _read_docx(path: str) -> str:
    try:
        with zipfile.ZipFile(path) as archive:
            document = archive.read("word/document.xml")
    except (zipfile.BadZipFile, KeyError) as exc:
        raise ValueError("invalid DOCX file: {0}".format(exc))
    root = ElementTree.fromstring(document)
    namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    paragraphs = []
    for paragraph in root.findall(".//w:p", namespace):
        text = "".join(node.text or "" for node in paragraph.findall(".//w:t", namespace)).strip()
        if text:
            paragraphs.append(text)
    return "\n".join(paragraphs)


def _read_pdf(path: str) -> str:
    try:
        import fitz  # type: ignore
    except ImportError:
        raise ValueError("PDF support requires PyMuPDF; install python-engine dependencies first")
    document = fitz.open(path)
    try:
        return "\n".join(page.get_text("text") for page in document)
    finally:
        document.close()

