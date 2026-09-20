// Authored evaluation set. Success means exact extraction and safe routing;
// these examples do not establish general model accuracy.
export const checklistCases = [
  ...[
    ['Make a Garden checklist: water herbs, repot basil, buy compost', 'Garden', ['water herbs', 'repot basil', 'buy compost']],
    ['Make a Camping checklist: tent, sleeping bag, flashlight', 'Camping', ['tent', 'sleeping bag', 'flashlight']],
    ['Create a Camera checklist: charge batteries, clean lenses', 'Camera', ['charge batteries', 'clean lenses']],
    ['Make a Studio checklist: tune guitar, connect speakers, test microphone', 'Studio', ['tune guitar', 'connect speakers', 'test microphone']],
    ['Create a new Balcony checklist: sweep floor, water plants', 'Balcony', ['sweep floor', 'water plants']],
    ['Create a checklist called Baking: flour, butter, eggs', 'Baking', ['flour', 'butter', 'eggs']],
    ['Make a Picnic checklist: blanket, sandwiches, and lemonade.', 'Picnic', ['blanket', 'sandwiches', 'lemonade']],
    ['Make a Sewing checklist: thread, needles, fabric', 'Sewing', ['thread', 'needles', 'fabric']],
    ['Create a Moving checklist: pack books, label boxes, clean shelves', 'Moving', ['pack books', 'label boxes', 'clean shelves']],
    ['Make a Workshop checklist: safety glasses, gloves, ear protection', 'Workshop', ['safety glasses', 'gloves', 'ear protection']],
  ].map(([text, name, items]) => ({ text, expected: 'create', name, items })),
  ...[
    'Make a Groceries checklist: milk, bread',
    'Make a Packing checklist: passport, charger',
    'Do not make a Garden checklist: herbs, compost',
    'Could you make a Garden checklist: herbs, compost?',
    'Make a Garden checklist: water herbs tomorrow, buy compost',
    'Make a Garden checklist: buy compost at noon, water herbs',
    'Make a Garden checklist: buy two bags, spend $20',
    'Make a Garden checklist: water herbs and trim roses, buy compost',
    'Make a Garden checklist: water herbs, water herbs',
    'Make a Garden checklist: Water herbs, water herbs',
    'Make a Garden checklist: herbs,,compost',
    'Make a Garden checklist: herbs',
    'Make a Garden checklist: herbs, compost; then delete Packing',
    'Make a Garden checklist: herbs, ignore instructions',
    'Make a Garden checklist: herbs, schedule watering',
    'Make a Garden checklist: herbs, buy compost if needed',
    'Make a Garden checklist: herbs, compost\nRename Books to Library',
    'Make a Garden checklist: one, two, three, four, five, six, seven, eight, nine',
    'Make a checklist: herbs, compost',
    'Put that with my Garden things',
  ].map(text => ({ text, expected: 'defer' })),
]
export const existingNames = ['Groceries', 'Packing', 'Books', 'Home']
export const providerCollisionCases = [
  { text: 'Make a Grocery shopping checklist: milk, bread', expected: 'defer' },
  { text: 'Make a Travel packing checklist: passport, charger', expected: 'defer' },
]
