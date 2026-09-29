export type StatusTone = 'busy' | 'idle' | 'ok' | 'warn' | 'mouse';

export interface StatusAction {
  label: string;
  onClick: () => void;
}

/** Small pill at the top: always tells the user what the machine thinks is happening. */
export class Status {
  readonly el: HTMLElement;
  private text: HTMLElement;
  private btn: HTMLButtonElement;
  private key = '';
  private action: StatusAction | null = null;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'status';
    this.el.setAttribute('role', 'status');
    this.el.innerHTML = '<span class="status-dot"></span><span class="status-text"></span><button class="status-btn" data-hit hidden></button>';
    this.text = this.el.querySelector('.status-text')!;
    this.btn = this.el.querySelector('.status-btn')!;
    this.btn.addEventListener('click', () => this.action?.onClick());
    parent.append(this.el);
  }

  /** Cheap to call every frame: only touches the DOM when something changed. */
  set(text: string, tone: StatusTone, action: StatusAction | null = null, quiet = false): void {
    const key = `${text}|${tone}|${action?.label ?? ''}|${quiet}`;
    if (key === this.key) return;
    this.key = key;
    this.text.textContent = text;
    this.el.dataset.tone = tone;
    this.el.classList.toggle('is-quiet', quiet);
    this.action = action;
    this.btn.hidden = !action;
    this.btn.textContent = action?.label ?? '';
  }
}
