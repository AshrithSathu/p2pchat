const INSTALL_COMMAND =
  'curl -fsSL https://p2pchat-relay.sathuashrith.com/install.sh | sh';

function requireElement<T extends HTMLElement>(
  id: string,
  constructor: new () => T,
): T {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new Error(`Missing required element: #${id}`);
  }
  return element;
}

const command = requireElement('install-command', HTMLElement);
const copyButton = requireElement('copy-command', HTMLButtonElement);
let resetTimer: number | undefined;

command.textContent = INSTALL_COMMAND;

async function copyInstallCommand(): Promise<void> {
  try {
    await navigator.clipboard.writeText(INSTALL_COMMAND);

    copyButton.dataset['copied'] = 'true';
    copyButton.setAttribute('aria-label', 'Install command copied');

    if (resetTimer !== undefined) {
      window.clearTimeout(resetTimer);
    }

    resetTimer = window.setTimeout(() => {
      delete copyButton.dataset['copied'];
      copyButton.setAttribute('aria-label', 'Copy install command');
      resetTimer = undefined;
    }, 1800);
  } catch {
    copyButton.textContent = 'select + copy';
    command.focus();
    window.getSelection()?.selectAllChildren(command);
  }
}

copyButton.addEventListener('click', () => {
  void copyInstallCommand();
});
