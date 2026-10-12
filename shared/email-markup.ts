/** A deliberately small email formatting language. Raw HTML, images, CSS and arbitrary URLs are never interpreted. */
export const escapeEmailHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
export function safeEmailLink(value: string): string | null {
  if (value.length > 2000 || /[\s\u0000-\u001f\u007f{}]/.test(value))
    return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !!url.hostname &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
type Rendered = { html: string; text: string };
export function renderEmailMarkup(
  source: string,
  personalize: (value: string) => string = (value) => value,
): Rendered {
  function inline(value: string, depth = 0): Rendered {
    let html = "",
      text = "",
      buffer = "";
    const flush = () => {
      const literal = personalize(buffer);
      html += escapeEmailHtml(literal);
      text += literal;
      buffer = "";
    };
    for (let i = 0; i < value.length;) {
      if (
        value[i] === "\\" &&
        i + 1 < value.length &&
        /[\\*_[\]~()]/.test(value[i + 1])
      ) {
        buffer += value[i + 1];
        i += 2;
        continue;
      }
      const link = value
        .slice(i)
        .match(/^\[([^\]\n]{1,1000})\]\(([^()\s]{1,2000})\)/);
      if (link) {
        const href = safeEmailLink(link[2]);
        if (href) {
          flush();
          const label = personalize(link[1]);
          html += `<a href="${escapeEmailHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeEmailHtml(label)}</a>`;
          text += `${label} (${href})`;
          i += link[0].length;
          continue;
        }
      }
      const marker = ["**", "__", "~~", "*", "_"].find((token) =>
        value.startsWith(token, i),
      );
      if (marker && depth < 5) {
        const end = value.indexOf(marker, i + marker.length);
        if (end > i + marker.length) {
          flush();
          const nested = inline(value.slice(i + marker.length, end), depth + 1),
            tag = marker.length === 1 ? "em" : marker === "~~" ? "s" : "strong";
          html += `<${tag}>${nested.html}</${tag}>`;
          text += nested.text;
          i = end + marker.length;
          continue;
        }
      }
      buffer += value[i++];
    }
    flush();
    return { html, text };
  }
  const html: string[] = [],
    plain: string[] = [];
  let list: "ul" | "ol" | null = null;
  const close = () => {
    if (list) {
      html.push(`</${list}>`);
      list = null;
    }
  };
  for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
    const item = line.match(/^\s*(?:([-*]) |(\d{1,3})\. )(.*)$/);
    if (item) {
      const type = item[1] ? "ul" : "ol";
      if (list !== type) {
        close();
        list = type;
        html.push(`<${type}>`);
      }
      const result = inline(item[3]);
      html.push(`<li>${result.html}</li>`);
      plain.push(`${item[1] ? "-" : `${item[2]}.`} ${result.text}`);
    } else {
      close();
      const result = inline(line);
      html.push(`<div>${result.html || "<br>"}</div>`);
      plain.push(result.text);
    }
  }
  close();
  return { html: html.join(""), text: plain.join("\n") };
}
