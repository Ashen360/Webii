export interface ScreenAction {
  label: string;
  primary?: boolean;
  onClick: () => void;
}

export interface ScreenSpec {
  title: string;
  body: string;
  note?: string;
  actions: ScreenAction[];
}

let current: HTMLElement | null = null;

/** Full-screen explanation card (gate, errors). One at a time. */
export function showScreen(spec: ScreenSpec): () => void {
  closeScreen();
  const el = document.createElement('div');
  el.className = 'screen';
  const card = document.createElement('div');
  card.className = 'screen-card';

  const h = document.createElement('h1');
  h.textContent = spec.title;
  const p = document.createElement('p');
  p.textContent = spec.body;
  card.append(h, p);
  if (spec.note) {
    const n = document.createElement('p');
    n.className = 'screen-note';
    n.textContent = spec.note;
    card.append(n);
  }
  const row = document.createElement('div');
  row.className = 'screen-actions';
  for (const a of spec.actions) {
    const b = document.createElement('button');
    b.className = a.primary ? 'btn btn-primary' : 'btn';
    b.dataset.hit = '';
    b.textContent = a.label;
    b.addEventListener('click', () => {
      closeScreen();
      a.onClick();
    });
    row.append(b);
  }
  card.append(row);
  el.append(card);
  document.body.append(el);
  document.body.classList.add('has-screen');
  current = el;
  (row.querySelector('.btn-primary') as HTMLButtonElement | null)?.focus();
  return closeScreen;
}

export function closeScreen(): void {
  current?.remove();
  current = null;
  document.body.classList.remove('has-screen');
}
