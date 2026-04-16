/**
 * Seed script for the semantic cache testing instance.
 * Uses the mock embedder (128-dim, word-overlap-based).
 * Run: npx tsx seed.ts
 */

import Valkey from 'iovalkey';
import { randomUUID } from 'node:crypto';
import { mockEmbed } from './mock-embedder';

const PORT = 6399;
const NAME = 'betterdb_scache';
const DIM = 128;

const INDEX = `${NAME}:idx`;
const PREFIX = `${NAME}:entry:`;

// ─── Fake Q&A dataset ─────────────────────────────────────────────────────────

const entries: { prompt: string; response: string; model: string; category: string }[] = [
  // Geography
  { prompt: 'What is the capital of France?', response: 'The capital of France is Paris.', model: 'gpt-4o', category: 'geography' },
  { prompt: 'What is the capital of Germany?', response: 'The capital of Germany is Berlin.', model: 'gpt-4o', category: 'geography' },
  { prompt: 'What is the capital of Japan?', response: 'The capital of Japan is Tokyo.', model: 'gpt-4o', category: 'geography' },
  { prompt: 'What is the capital of Australia?', response: 'The capital of Australia is Canberra.', model: 'gpt-4o', category: 'geography' },
  { prompt: 'What is the capital of Brazil?', response: 'The capital of Brazil is Brasília.', model: 'gpt-4o', category: 'geography' },
  { prompt: 'What is the largest country by area?', response: 'Russia is the largest country in the world by area, covering about 17.1 million km².', model: 'gpt-4o', category: 'geography' },
  { prompt: 'What is the longest river in the world?', response: 'The Nile River is generally considered the longest river in the world at approximately 6,650 km.', model: 'gpt-4o', category: 'geography' },
  { prompt: 'What is the tallest mountain in the world?', response: 'Mount Everest is the tallest mountain in the world at 8,849 metres above sea level.', model: 'gpt-4o', category: 'geography' },
  { prompt: 'Which continent is Egypt in?', response: 'Egypt is located in Africa, though it also has territory in Asia (the Sinai Peninsula).', model: 'gpt-4o', category: 'geography' },
  { prompt: 'How many countries are there in South America?', response: 'There are 12 sovereign countries in South America.', model: 'gpt-4o', category: 'geography' },

  // Science
  { prompt: 'What is the speed of light?', response: 'The speed of light in a vacuum is approximately 299,792 kilometres per second (about 186,282 miles per second).', model: 'gpt-4o', category: 'science' },
  { prompt: 'What is the chemical formula for water?', response: 'The chemical formula for water is H₂O — two hydrogen atoms bonded to one oxygen atom.', model: 'claude-sonnet-4-6', category: 'science' },
  { prompt: 'What is photosynthesis?', response: 'Photosynthesis is the process by which plants use sunlight, water, and carbon dioxide to produce oxygen and energy in the form of glucose.', model: 'gpt-4o', category: 'science' },
  { prompt: 'What is DNA?', response: 'DNA (deoxyribonucleic acid) is a molecule that carries the genetic instructions for the development, functioning, growth, and reproduction of all known organisms.', model: 'gpt-4o', category: 'science' },
  { prompt: 'What is the periodic table?', response: 'The periodic table is a tabular arrangement of chemical elements, ordered by atomic number, electron configuration, and recurring chemical properties.', model: 'claude-sonnet-4-6', category: 'science' },
  { prompt: 'What causes rainbows?', response: 'Rainbows are caused by the refraction, dispersion, and reflection of sunlight inside water droplets, separating white light into its component colours.', model: 'gpt-4o', category: 'science' },
  { prompt: 'How does gravity work?', response: 'Gravity is a fundamental force that attracts objects with mass toward each other. According to general relativity, massive objects curve spacetime, causing other objects to follow curved paths.', model: 'gpt-4o', category: 'science' },
  { prompt: 'What is the boiling point of water?', response: 'Water boils at 100°C (212°F) at standard atmospheric pressure (1 atm).', model: 'gpt-4o', category: 'science' },
  { prompt: 'What is the human genome?', response: 'The human genome is the complete set of genetic information in a human cell, comprising about 3 billion base pairs of DNA organised into 23 pairs of chromosomes.', model: 'claude-sonnet-4-6', category: 'science' },
  { prompt: 'What is a black hole?', response: 'A black hole is a region of spacetime where gravity is so strong that nothing — not even light — can escape from it. They form when massive stars collapse at the end of their life cycle.', model: 'gpt-4o', category: 'science' },

  // History
  { prompt: 'Who wrote Romeo and Juliet?', response: 'Romeo and Juliet was written by William Shakespeare, most likely between 1594 and 1596.', model: 'gpt-4o', category: 'history' },
  { prompt: 'When did World War II end?', response: 'World War II ended in 1945 — in Europe on 8 May (V-E Day) and in the Pacific on 2 September (V-J Day) with Japan\'s formal surrender.', model: 'gpt-4o', category: 'history' },
  { prompt: 'Who was the first President of the United States?', response: 'George Washington was the first President of the United States, serving from 1789 to 1797.', model: 'gpt-4o', category: 'history' },
  { prompt: 'When did the French Revolution begin?', response: 'The French Revolution began in 1789, marked by events such as the storming of the Bastille on 14 July 1789.', model: 'claude-sonnet-4-6', category: 'history' },
  { prompt: 'Who built the Great Wall of China?', response: 'The Great Wall of China was built by various Chinese dynasties over many centuries. The most well-known sections were built during the Ming dynasty (1368–1644).', model: 'gpt-4o', category: 'history' },
  { prompt: 'When did the Roman Empire fall?', response: 'The Western Roman Empire fell in 476 AD when the Germanic chieftain Odoacer deposed the last emperor, Romulus Augustulus. The Eastern Roman Empire (Byzantine) continued until 1453.', model: 'gpt-4o', category: 'history' },
  { prompt: 'Who invented the printing press?', response: 'Johannes Gutenberg invented the movable-type printing press around 1440 in Europe, revolutionising the spread of information.', model: 'gpt-4o', category: 'history' },
  { prompt: 'What was the Cold War?', response: 'The Cold War was a period of geopolitical tension between the United States and the Soviet Union and their respective allies from approximately 1947 to 1991.', model: 'claude-sonnet-4-6', category: 'history' },
  { prompt: 'When did humans first land on the Moon?', response: 'Humans first landed on the Moon on 20 July 1969 during NASA\'s Apollo 11 mission. Neil Armstrong was the first person to walk on the lunar surface.', model: 'gpt-4o', category: 'history' },
  { prompt: 'Who was Cleopatra?', response: 'Cleopatra VII was the last active ruler of the Ptolemaic Kingdom of Egypt. She ruled from 51 BC until her death in 30 BC, and is famous for her relationships with Julius Caesar and Mark Antony.', model: 'gpt-4o', category: 'history' },

  // Technology
  { prompt: 'What is machine learning?', response: 'Machine learning is a branch of artificial intelligence that enables systems to learn from data and improve their performance on tasks without being explicitly programmed.', model: 'gpt-4o', category: 'technology' },
  { prompt: 'What is a neural network?', response: 'A neural network is a computational model inspired by the structure of biological brains, consisting of layers of interconnected nodes (neurons) that process information and learn patterns from data.', model: 'claude-sonnet-4-6', category: 'technology' },
  { prompt: 'What is the difference between RAM and storage?', response: 'RAM (Random Access Memory) is fast, temporary memory used by running programs. Storage (HDD/SSD) is slower, persistent memory used to save files and the operating system.', model: 'gpt-4o', category: 'technology' },
  { prompt: 'What is an API?', response: 'An API (Application Programming Interface) is a set of rules and protocols that allows different software applications to communicate with each other.', model: 'gpt-4o', category: 'technology' },
  { prompt: 'What is cloud computing?', response: 'Cloud computing is the delivery of computing services — including servers, storage, databases, networking, software, and analytics — over the internet, enabling flexible resources and economies of scale.', model: 'gpt-4o', category: 'technology' },
  { prompt: 'What is open source software?', response: 'Open source software is software whose source code is made publicly available for anyone to view, use, modify, and distribute, fostering collaboration and transparency.', model: 'claude-sonnet-4-6', category: 'technology' },
  { prompt: 'What is a database?', response: 'A database is an organised collection of structured data stored and accessed electronically, typically managed by a database management system (DBMS).', model: 'gpt-4o', category: 'technology' },
  { prompt: 'What is the difference between HTTP and HTTPS?', response: 'HTTP (HyperText Transfer Protocol) transfers data in plain text. HTTPS adds TLS/SSL encryption, ensuring data is securely transmitted between client and server.', model: 'gpt-4o', category: 'technology' },
  { prompt: 'What is a blockchain?', response: 'A blockchain is a distributed ledger technology that records transactions in a chain of cryptographically linked blocks, making records tamper-resistant and transparent.', model: 'gpt-4o', category: 'technology' },
  { prompt: 'What is Docker?', response: 'Docker is an open-source platform that packages applications and their dependencies into lightweight, portable containers, enabling consistent behaviour across different environments.', model: 'claude-sonnet-4-6', category: 'technology' },

  // General knowledge / FAQ
  { prompt: 'How many days are in a year?', response: 'A standard year has 365 days. A leap year, which occurs every 4 years (with some exceptions), has 366 days.', model: 'gpt-4o', category: 'faq' },
  { prompt: 'What is the speed of sound?', response: 'The speed of sound in dry air at 20°C is approximately 343 metres per second (about 1,235 km/h).', model: 'gpt-4o', category: 'faq' },
  { prompt: 'How many bones are in the human body?', response: 'An adult human body has 206 bones. Babies are born with around 270–300 bones, which gradually fuse as they grow.', model: 'gpt-4o', category: 'faq' },
  { prompt: 'What language is spoken in Brazil?', response: 'Portuguese is the official and most widely spoken language in Brazil.', model: 'gpt-4o', category: 'faq' },
  { prompt: 'What is the largest ocean on Earth?', response: 'The Pacific Ocean is the largest ocean, covering more than 165 million km² — about one-third of Earth\'s surface.', model: 'gpt-4o', category: 'faq' },
  { prompt: 'How long does it take light to travel from the Sun to Earth?', response: 'It takes approximately 8 minutes and 20 seconds for light to travel from the Sun to Earth.', model: 'claude-sonnet-4-6', category: 'faq' },
  { prompt: 'What is inflation?', response: 'Inflation is the rate at which the general level of prices for goods and services rises over time, reducing the purchasing power of money.', model: 'gpt-4o', category: 'faq' },
  { prompt: 'What causes thunder?', response: 'Thunder is caused by the rapid expansion of air superheated by a lightning bolt. The sound wave produced is what we hear as thunder.', model: 'gpt-4o', category: 'faq' },
  { prompt: 'How do vaccines work?', response: 'Vaccines train the immune system to recognise and fight specific pathogens by exposing it to a harmless version or component of the pathogen, building immunity without causing disease.', model: 'claude-sonnet-4-6', category: 'faq' },
  { prompt: 'What is the Fibonacci sequence?', response: 'The Fibonacci sequence is a series of numbers where each number is the sum of the two preceding ones: 0, 1, 1, 2, 3, 5, 8, 13, 21, 34 ...', model: 'gpt-4o', category: 'faq' },

  // Valkey / databases (on-topic for this testing instance)
  { prompt: 'What is Valkey?', response: 'Valkey is an open-source, high-performance key-value data store forked from Redis 7.2.4. It is maintained by the Linux Foundation and supports a wide range of data structures.', model: 'gpt-4o', category: 'databases' },
  { prompt: 'What is Redis?', response: 'Redis is an open-source, in-memory data structure store used as a database, cache, message broker, and streaming engine. It supports strings, hashes, lists, sets, sorted sets, and more.', model: 'gpt-4o', category: 'databases' },
  { prompt: 'What is a cache hit?', response: 'A cache hit occurs when the data requested by an application is found in the cache, avoiding a slower lookup from the primary data source.', model: 'gpt-4o', category: 'databases' },
  { prompt: 'What is a cache miss?', response: 'A cache miss occurs when the data requested by an application is not found in the cache, requiring retrieval from the primary data source and usually storing it in the cache for future requests.', model: 'gpt-4o', category: 'databases' },
  { prompt: 'What is semantic caching?', response: 'Semantic caching stores LLM responses indexed by the meaning of the prompt rather than its exact text, so similar questions (e.g., "What is the capital of France?" and "France capital city?") can return the same cached answer.', model: 'claude-sonnet-4-6', category: 'databases' },
  { prompt: 'What is vector search?', response: 'Vector search is a technique that finds semantically similar items by comparing high-dimensional embedding vectors using distance metrics like cosine similarity or Euclidean distance.', model: 'gpt-4o', category: 'databases' },
  { prompt: 'What is HNSW?', response: 'HNSW (Hierarchical Navigable Small World) is an approximate nearest neighbour algorithm that organises vectors in a layered graph structure for fast, memory-efficient similarity search.', model: 'claude-sonnet-4-6', category: 'databases' },
  { prompt: 'What is cosine similarity?', response: 'Cosine similarity measures the cosine of the angle between two vectors, indicating how similar their directions are regardless of magnitude. A score of 1 means identical direction, 0 means orthogonal.', model: 'gpt-4o', category: 'databases' },
  { prompt: 'What is an embedding?', response: 'An embedding is a dense numerical representation of data (text, images, etc.) in a continuous vector space, where semantically similar items are placed close together.', model: 'gpt-4o', category: 'databases' },
  { prompt: 'What is TTL in caching?', response: 'TTL (Time To Live) is the duration for which a cached entry remains valid before it expires and must be re-fetched from the source.', model: 'gpt-4o', category: 'databases' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function encodeFloat32(vec: number[]): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

async function createIndex(client: Valkey): Promise<void> {
  try {
    await (client as any).call(
      'FT.CREATE', INDEX,
      'ON', 'HASH',
      'PREFIX', '1', PREFIX,
      'SCHEMA',
      'prompt',      'TEXT',    'NOSTEM',
      'response',    'TEXT',    'NOSTEM',
      'model',       'TAG',
      'category',    'TAG',
      'inserted_at', 'NUMERIC', 'SORTABLE',
      'embedding',   'VECTOR',  'HNSW', '6',
        'TYPE',            'FLOAT32',
        'DIM',             String(DIM),
        'DISTANCE_METRIC', 'COSINE',
    );
    console.log(`  Created index ${INDEX}`);
  } catch (err: any) {
    if (err?.message?.includes('Index already exists')) {
      console.log(`  Index ${INDEX} already exists — skipping creation`);
    } else {
      throw err;
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const client = new Valkey({ host: 'localhost', port: PORT });

  try {
    await client.ping();
    console.log(`Connected to localhost:${PORT}\n`);

    await createIndex(client);

    console.log(`\nSeeding ${entries.length} entries...\n`);

    const categories = [...new Set(entries.map(e => e.category))];

    for (const entry of entries) {
      const embedding = await mockEmbed(entry.prompt);
      const key = `${PREFIX}${randomUUID()}`;

      await client.hset(key, {
        prompt: entry.prompt,
        response: entry.response,
        model: entry.model,
        category: entry.category,
        inserted_at: Date.now().toString(),
        metadata: JSON.stringify({}),
        embedding: encodeFloat32(embedding),
      });

      process.stdout.write(`  [${entry.category.padEnd(10)}] ${entry.prompt.slice(0, 60)}\n`);
    }

    // Print summary
    console.log('\n─────────────────────────────────────');
    console.log(`Seeded ${entries.length} entries across ${categories.length} categories:`);
    for (const cat of categories) {
      const count = entries.filter(e => e.category === cat).length;
      console.log(`  ${cat.padEnd(12)} ${count} entries`);
    }

    // Verify via FT.INFO
    const info: any = await (client as any).call('FT.INFO', INDEX);
    const numDocs = info[info.indexOf('num_docs') + 1];
    console.log(`\nIndex ${INDEX}: ${numDocs} documents indexed`);

  } finally {
    client.disconnect();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
