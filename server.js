const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3001;
const DATA_FILE = path.join(__dirname, 'data', 'tasks.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function todayStr() {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().slice(0, 10);
}

function ensureDataFile() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, '[]', 'utf8');
  }
}

function readTasks() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    fs.writeFileSync(DATA_FILE, '[]', 'utf8');
    return [];
  }
}

function writeTasks(tasks) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(tasks, null, 2), 'utf8');
}

function nextId(tasks) {
  return tasks.reduce((max, task) => Math.max(max, Number(task.id) || 0), 0) + 1;
}

function addTask(title, due) {
  const tasks = readTasks();
  const task = {
    id: nextId(tasks),
    title: String(title).trim(),
    due: due || todayStr(),
    done: false
  };
  tasks.push(task);
  writeTasks(tasks);
  return task;
}

function firstVerb(text, verbs) {
  let index = -1;
  let word = '';
  verbs.forEach((verb) => {
    const found = text.indexOf(verb);
    if (found === -1) return;
    if (index === -1 || found < index || (found === index && verb.length > word.length)) {
      index = found;
      word = verb;
    }
  });
  return { index, word };
}

function cleanAddTitle(text) {
  return String(text)
    .trim()
    .replace(/^(一个|一条|一项|一下|上|个|条)\s*/, '')
    .replace(/的任务$/, '')
    .replace(/任务$/, '')
    .trim();
}

function extractAddTitle(command) {
  const colon = command.match(/[：:]\s*(.+)$/);
  if (colon && colon[1].trim()) {
    return cleanAddTitle(colon[1]);
  }
  const afterVerb = command.match(/(增加|添加|新增|加)(.*)$/);
  if (!afterVerb) return '';
  return cleanAddTitle(afterVerb[2]);
}

function extractDoneKeyword(command) {
  const after = command.match(/(完成|做完)\s*(.*)$/);
  if (after && after[2].trim()) {
    return after[2]
      .replace(/[。！？.!?]+$/, '')
      .replace(/了$/, '')
      .replace(/的任务$/, '')
      .replace(/任务$/, '')
      .trim();
  }
  const before = command.match(/^(.*?)(完成|做完)/);
  if (before && before[1].trim()) {
    return before[1].replace(/^把/, '').replace(/了$/, '').trim();
  }
  return '';
}

function datePlusDays(days) {
  const parts = todayStr().split('-').map(Number);
  const date = new Date(parts[0], parts[1] - 1, parts[2] + days);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function findByKeyword(keyword) {
  return readTasks().filter((task) => task.title.includes(keyword));
}

function formatMatchList(matches) {
  return matches.map((task, index) => `${index + 1}. ${task.title}（截止 ${task.due}）`).join('\n');
}

function parseChoice(command) {
  const matched = command.match(/^(?:选择)?\s*(\d+)\s*[.、号个]?$/);
  return matched ? Number(matched[1]) : null;
}

function deleteTaskById(id) {
  const tasks = readTasks();
  const task = tasks.find((item) => item.id === id);
  if (!task) return null;
  writeTasks(tasks.filter((item) => item.id !== id));
  return task;
}

function rescheduleTaskById(id, dayNum) {
  const tasks = readTasks();
  const task = tasks.find((item) => item.id === id);
  if (!task) return null;
  task.due = datePlusDays(dayNum - 1);
  writeTasks(tasks);
  return task;
}

function applyMatchedAction(type, task, dayNum) {
  if (type === 'delete') {
    const removed = deleteTaskById(task.id);
    if (!removed) return { ok: false, message: '未找到该任务' };
    return { ok: true, message: `已删除：${removed.title}` };
  }
  const updated = rescheduleTaskById(task.id, dayNum);
  if (!updated) return { ok: false, message: '未找到该任务' };
  return { ok: true, message: `已把「${updated.title}」换到第${dayNum}天（${updated.due}）` };
}

function resolveKeywordAction(type, keyword, dayNum) {
  const matches = findByKeyword(keyword);
  if (matches.length === 0) {
    return { ok: false, message: '未找到该任务' };
  }
  if (matches.length === 1) {
    return applyMatchedAction(type, matches[0], dayNum);
  }
  pendingChoice = { type, matches, dayNum };
  return {
    ok: true,
    message: `匹配到多条任务，请回复序号选择：\n${formatMatchList(matches)}`
  };
}

let pendingChoice = null;

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/tasks', (req, res) => {
  res.json(readTasks());
});

app.post('/api/tasks', (req, res) => {
  const title = req.body && typeof req.body.title === 'string' ? req.body.title.trim() : '';
  if (!title) {
    return res.status(400).json({ error: 'title 必填' });
  }
  const due = req.body.due && String(req.body.due).trim() ? String(req.body.due).trim() : todayStr();
  const task = addTask(title, due);
  res.status(201).json(task);
});

app.patch('/api/tasks/:id', (req, res) => {
  const id = Number(req.params.id);
  const tasks = readTasks();
  const task = tasks.find((item) => item.id === id);
  if (!task) {
    return res.status(404).json({ error: '任务不存在' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const hasTitle = typeof body.title === 'string';
  const hasDue = typeof body.due === 'string';
  const hasDone = typeof body.done === 'boolean';

  if (hasTitle || hasDue || hasDone) {
    if (hasTitle) {
      const title = body.title.trim();
      if (!title) {
        return res.status(400).json({ error: 'title 必填' });
      }
      task.title = title;
    }
    if (hasDue) {
      const due = body.due.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) {
        return res.status(400).json({ error: 'due 格式应为 YYYY-MM-DD' });
      }
      task.due = due;
    }
    if (hasDone) {
      task.done = body.done;
    }
  } else {
    task.done = !task.done;
  }

  writeTasks(tasks);
  res.json(task);
});

app.delete('/api/tasks/:id', (req, res) => {
  const id = Number(req.params.id);
  const removed = deleteTaskById(id);
  if (!removed) {
    return res.status(404).json({ error: '任务不存在' });
  }
  res.json(removed);
});

app.post('/api/plan', (req, res) => {
  const command = req.body && typeof req.body.command === 'string' ? req.body.command.trim() : '';
  if (!command) {
    return res.status(400).json({ ok: false, message: '请输入指令' });
  }

  const choice = parseChoice(command);
  if (pendingChoice && choice !== null) {
    const selected = pendingChoice.matches[choice - 1];
    if (!selected) {
      return res.json({
        ok: false,
        message: `请回复 1-${pendingChoice.matches.length} 之间的序号`
      });
    }
    const action = pendingChoice;
    pendingChoice = null;
    return res.json(applyMatchedAction(action.type, selected, action.dayNum));
  }
  pendingChoice = null;

  if (/没做|未完成|还没/.test(command)) {
    const pending = readTasks().filter((task) => task.due === todayStr() && !task.done);
    if (pending.length === 0) {
      return res.json({ ok: true, message: '今天没有未完成的任务。', tasks: [] });
    }
    const lines = pending.map((task) => `· ${task.title}（截止 ${task.due}）`).join('\n');
    return res.json({
      ok: true,
      message: `今天还没做的任务（${pending.length} 条）：\n${lines}`,
      tasks: pending
    });
  }

  const deleteMatch = command.match(/删除\s*(.+)$/);
  if (deleteMatch) {
    const keyword = deleteMatch[1].trim();
    if (!keyword) {
      return res.json({ ok: false, message: '未找到该任务' });
    }
    return res.json(resolveKeywordAction('delete', keyword));
  }

  const moveMatch = command.match(/把\s*(.+?)\s*换成第(\d+)天/);
  if (moveMatch) {
    const keyword = moveMatch[1].trim();
    const dayNum = Number(moveMatch[2]);
    if (!keyword) {
      return res.json({ ok: false, message: '未找到该任务' });
    }
    if (dayNum < 1 || dayNum > 7) {
      return res.json({ ok: false, message: '请使用第1天到第7天' });
    }
    return res.json(resolveKeywordAction('reschedule', keyword, dayNum));
  }

  const addVerb = firstVerb(command, ['增加', '添加', '新增', '加']);
  const doneVerb = firstVerb(command, ['完成', '做完']);
  const isAdd = addVerb.index !== -1 && (doneVerb.index === -1 || addVerb.index < doneVerb.index);
  const isDone = doneVerb.index !== -1 && !isAdd;

  if (isAdd) {
    const title = extractAddTitle(command);
    if (!title) {
      return res.json({ ok: false, message: '请说明要新增的任务标题' });
    }
    const task = addTask(title, todayStr());
    return res.json({ ok: true, message: `已新增今天的任务：${task.title}`, task });
  }

  if (isDone) {
    const keyword = extractDoneKeyword(command);
    if (!keyword) {
      return res.json({ ok: false, message: '请说明要完成哪一项' });
    }
    const tasks = readTasks();
    const task = tasks.find((item) => !item.done && item.title.includes(keyword));
    if (!task) {
      return res.json({ ok: false, message: `没有找到未完成的任务：${keyword}` });
    }
    task.done = true;
    writeTasks(tasks);
    return res.json({ ok: true, message: `已完成：${task.title}`, task });
  }

  return res.json({
    ok: false,
    message: '暂不支持该指令。可以试试：\n今天加一个：复习英语\n列出今天还没做的\n完成 复习英语'
  });
});

ensureDataFile();

app.listen(PORT, () => {
  console.log(`学习助手已启动：http://localhost:${PORT}`);
});
