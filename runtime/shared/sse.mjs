export function extractSseMessages(buffer) {
  const normalized = String(buffer).replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() || "";
  const messages = parts
    .map((block) => parseSseBlock(block))
    .filter((msg) => msg != null);
  return { messages, rest };
}

function parseSseBlock(block) {
  const lines = block.split("\n");
  let id = null;
  let type = "message";
  const dataLines = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("id:")) {
      id = line.slice(3).trim();
      continue;
    }
    if (line.startsWith("event:")) {
      type = line.slice(6).trim() || "message";
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  const dataText = dataLines.join("\n");
  let data = null;
  if (dataText) {
    try {
      data = JSON.parse(dataText);
    } catch {
      data = dataText;
    }
  }

  return {
    id,
    type,
    data
  };
}
