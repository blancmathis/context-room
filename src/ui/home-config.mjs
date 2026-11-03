// The configurable Home (T-021). Pure data: no DOM, so the Hub server and the browser share it.
// The Home is a list of blocks. The person shows, hides, reorders and sizes them. The Hub keeps the list.

export const HOME_TYPES = [['all', 'All'], ['md', 'Markdown'], ['html', 'HTML'], ['crnb', 'Notebooks'], ['image', 'Images'], ['other', 'Other']];
export const HOME_FILE_SORTS = [['name', 'Name'], ['recent', 'Modified'], ['type', 'Type']];
export const HOME_PROJECT_SORTS = [['name', 'Name'], ['opened', 'Last opened'], ['reviews', 'Reviews']];

/** Every block the Home can show. `panel` = an existing panel of the page that the block moves. */
export const HOME_BLOCKS = [
  { type: 'projects', title: 'Projects', hint: 'Your main projects as tiles. Pin the ones you want first.' },
  { type: 'files', title: 'Files of a project', hint: 'Browse the files of one project: Markdown, HTML, notebooks.' },
  { type: 'recent', title: 'Recent files', hint: 'One feed of the newest files across your projects.' },
  { type: 'reviews', title: 'Review queue', hint: 'Changes that wait for your yes or no.', panel: 'reviewQueuePanel' },
  { type: 'notebooks', title: 'Notebooks', hint: 'Your tablet notebooks and quick notes.', panel: 'notebookSpacePanel' },
  { type: 'health', title: 'Context health', hint: 'What an agent may misread: stale or broken documents.', panel: 'contextHealthPanel' },
  { type: 'documents', title: 'Documents', hint: 'The documentation map of the project.', panel: 'documentsMapPanel' },
];
export const HOME_BLOCK_TYPES = HOME_BLOCKS.map(block => block.type);
export const HOME_SIZES = ['full', 'half'];
export const HOME_MAX_BLOCKS = HOME_BLOCK_TYPES.length;

export const defaultHomePrefs = () => ({ pinned: [], hidden: [], projectSort: 'opened', fileSort: 'name', type: 'all', showShared: false });

export function normalizeHomePrefs(raw) {
  const base = defaultHomePrefs();
  if (!raw || typeof raw !== 'object') return base;
  const list = value => Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string' && item.length <= 400))].slice(0, 500) : [];
  return {
    pinned: list(raw.pinned),
    hidden: list(raw.hidden).filter(key => !list(raw.pinned).includes(key)),
    projectSort: HOME_PROJECT_SORTS.some(([id]) => id === raw.projectSort) ? raw.projectSort : base.projectSort,
    fileSort: HOME_FILE_SORTS.some(([id]) => id === raw.fileSort) ? raw.fileSort : base.fileSort,
    type: HOME_TYPES.some(([id]) => id === raw.type) ? raw.type : base.type,
    showShared: raw.showShared === true,
  };
}

/** The default Home: the daily gesture first (projects, then their files), then what waits for the person. */
export const defaultHomeBlocks = () => [
  { type: 'projects', size: 'full' },
  { type: 'files', size: 'half' },
  { type: 'recent', size: 'half' },
  { type: 'reviews', size: 'half' },
  { type: 'notebooks', size: 'half' },
  { type: 'health', size: 'half' },
];

export const defaultHomeConfig = () => ({ version: 1, blocks: defaultHomeBlocks(), prefs: defaultHomePrefs() });

/** Unknown types and repeats drop out. A missing `blocks` list means the default; an empty list is a real choice. */
export function normalizeHomeConfig(raw) {
  if (!raw || typeof raw !== 'object') return defaultHomeConfig();
  const seen = new Set();
  const blocks = Array.isArray(raw.blocks)
    ? raw.blocks.filter(block => block && HOME_BLOCK_TYPES.includes(block.type) && !seen.has(block.type) && seen.add(block.type))
      .map(block => ({ type: block.type, size: HOME_SIZES.includes(block.size) ? block.size : 'half' }))
    : defaultHomeBlocks();
  return { version: 1, blocks, prefs: normalizeHomePrefs(raw.prefs) };
}

export const homeBlockInfo = type => HOME_BLOCKS.find(block => block.type === type) || null;
export const hiddenHomeBlocks = config => HOME_BLOCKS.filter(block => !config.blocks.some(item => item.type === block.type));

/** Each change returns a new config. Never mutates. */
export function moveHomeBlock(config, type, delta) {
  const index = config.blocks.findIndex(block => block.type === type);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= config.blocks.length) return config;
  const blocks = [...config.blocks];
  [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
  return { ...config, blocks };
}
export function removeHomeBlock(config, type) {
  return { ...config, blocks: config.blocks.filter(block => block.type !== type) };
}
export function addHomeBlock(config, type) {
  if (!HOME_BLOCK_TYPES.includes(type) || config.blocks.some(block => block.type === type)) return config;
  return { ...config, blocks: [...config.blocks, { type, size: 'full' }] };
}
export function sizeHomeBlock(config, type) {
  return { ...config, blocks: config.blocks.map(block => block.type === type ? { ...block, size: block.size === 'full' ? 'half' : 'full' } : block) };
}
