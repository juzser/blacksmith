async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

function renderNote(note) {
  const li = document.createElement("li");
  const title = document.createElement("strong");
  title.textContent = note.title;
  const body = document.createElement("p");
  body.textContent = note.body;
  li.append(title, body);
  for (const tag of note.tags) {
    const span = document.createElement("span");
    span.className = "tag";
    span.textContent = tag.name;
    li.append(span);
  }
  const del = document.createElement("button");
  del.textContent = "Delete";
  del.addEventListener("click", async () => {
    await api("DELETE", `/api/notes/${note.id}`);
    await refresh();
  });
  li.append(del);
  return li;
}

async function refresh() {
  const notes = await api("GET", "/api/notes");
  document.getElementById("notes").replaceChildren(...notes.map(renderNote));
}

document.getElementById("note-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = document.getElementById("note-title");
  const body = document.getElementById("note-body");
  await api("POST", "/api/notes", { title: title.value, body: body.value });
  event.target.reset();
  await refresh();
});

refresh();
