/*
config 和 input 都在本目录下，data.db init.sql 和 static 都在根目录下
*/

import { Cluster } from 'puppeteer-cluster';
import { performance } from 'perf_hooks';
import Database from 'better-sqlite3';
import juration from 'juration';
import chalk from 'chalk-template';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const whitelist = [
	['index.html', 'text/html; charset=utf-8', 'local'],
	['index.dart.js', 'text/javascript; charset=utf-8', 'local'],
	['md5.html', 'text/html; charset=utf-8', 'local'],
	['md5.js', 'text/javascript; charset=utf-8', 'local'],
	['md5.css', 'text/css; charset=utf-8', 'local'],
	// mark：似乎必须 hook index.dart.js，拿到真正的值才能替换 gAd.md
	['gAd.md', 'text/markdown', 'local'],
	['zh.json', 'application/json; charset=utf-8', 'local'],
];
for (let i of whitelist)
	i.push(fs.readFileSync(path.join('static', i[0])));

// queue
const fullQueue = new Set(); // remove after finished

// database
const db = new Database('./data.db');

const init = fs.readFileSync('init.sql', 'utf8');
db.exec(init);

const insertName = db.prepare(`INSERT OR IGNORE INTO name (name) VALUES (?)`);
const insertManyNames = db.transaction(names => names.forEach(name => insertName.run(name)));
const updateNameScore = Object.fromEntries(
	['QP', 'QD', 'PP', 'PD'].map(mode => [mode, db.prepare(`UPDATE name SET ${mode} = ?, ${mode}_endpoint = ? WHERE name = ?`)])
);
const getNameScore = Object.fromEntries(
	['QP', 'QD', 'PP', 'PD'].map(mode => [mode, db.prepare(`SELECT ${mode} FROM name WHERE name = ?`)])
);
const updateNameSkill = new Array(37).fill(0).map((_, id) => db.prepare(`UPDATE name SET skill_${id} = ? WHERE name = ?`));
const setNameSkillData = db.prepare(`UPDATE name SET has_skillinfo = 1 WHERE name = ?`);

const skillMap = ['潜行', '净化', '瘟疫', '诅咒', '狂暴术', '吸血攻击', '会心一击', '生命之轮', '地裂术', '火球术', '冰冻术', '雷击术', '投毒', '连击', '铁壁', '加速术', '减速术', '蓄力', '聚气', '魅惑', '血祭', '分身', '幻术', '苏生术', '治愈魔法', '隐匿', '反击', '伤害反弹', '防御', '守护', '护身符', '垂死', '召唤亡灵', '吞噬', '零伤', '回避', '背刺'];

// config
const config = JSON.parse(fs.readFileSync(path.join(__dirname, './config.json')));
const testString = {
	QP: '!test!\n!\n\n$name',
	QD: '!test!\n!\n\n$name\n$name',
	PP: '!test!\n\n$name',
	PD: '!test!\n\n$name\n$name',
};

(async () => {
	// cluster
	const cluster = await Cluster.launch({
		concurrency: Cluster.CONCURRENCY_PAGE,
		maxConcurrency: config.threads,
		puppeteerOptions: {
			headless: true,
			args: [
				'--no-sandbox',
				'--disable-setuid-sandbox',
				'--disable-dev-shm-usage',
				'--no-first-run',
				'--no-zygote',
				'--disable-gpu'
			]
		},
		timeout: 600 * 1000
	});

	async function addItem(name, mode) {
		const item = [mode, name], serializedItem = JSON.stringify(item);

		if (getNameScore[mode].get(name)[mode] || fullQueue.has(serializedItem)) return;

		fullQueue.add(serializedItem);
		insertName.run(name);
		await cluster.queue(item);
	}

	let count = 0, totalTime = 0;
	await cluster.task(async ({ page, data: [mode, name] }) => new Promise(async resolve => {
		try {
			console.log(chalk`{magentaBright ${name} ${mode} started.}`)
			const startTime = performance.now();
			const strInBrowser = testString[mode].replace(/\$name/g, name);
			const configInBrowser = config[mode].thresholds;
			const serializedItem = JSON.stringify([mode, name]);

			await page.exposeFunction('resolve', async (success, skills, score, last) => {
				try {
					// await page.tracing.stop();
					count++;
					const duration = juration.stringify((performance.now() - startTime) / 1000, { format: 'micro' });

					updateNameScore[mode].run(score, last, name); // update score
					if (skills.length) { // update skills
						setNameSkillData.run(name);
						for (let [label, freq] of skills) {
							updateNameSkill[skillMap.indexOf(label)].run(freq, name);
						}
					}

					totalTime += (performance.now() - startTime) / 1000;
					if (!success)
						console.log(chalk`{redBright ${name} ${mode} failed with score {bold ${score}} at {bold ${(last / 100).toFixed(2).replace(/\.?0+$/, '')}%}. {bold (${duration})}}`);
					else {
						console.log(chalk`{greenBright ${name} ${mode} finished with score {bold ${score}}. {bold (${duration})}}`);

						if (config[mode].mode.includes('P'))
							for (let filteredMode in config)
								if (typeof config[filteredMode] === 'object')
									if (config[filteredMode].mode.includes('F')) await addItem(name, filteredMode);
					}

					fullQueue.delete(serializedItem);

					console.log(chalk`{yellowBright {bold progress: ${count} / ${fullQueue.size + count}, avg. time: ${juration.stringify(totalTime / count, { format: 'micro' })} (${juration.stringify(totalTime / count / config.threads, { format: 'micro' })}), ETA: ${juration.stringify(fullQueue.size * totalTime / count / config.threads, { format: 'micro' })}}}`);

					resolve();
				} catch (e) {
					console.error((new Date).toLocaleString(), e);
				}
			});
			await page.setRequestInterception(true);
			page.on('request', req => {
				let url = req.url();
				for (let [s, t, u, f] of whitelist)
					if (url.includes(s)) {
						if (u === 'remote') return req.continue();
						// console.log(url);
						return req.respond({
							status: 200,
							contentType: t,
							body: f
						});
					}
				return req.abort();
			});
			await page.evaluateOnNewDocument((config, str) => sessionStorage.setItem('data', JSON.stringify({
				config,
				str
			})), configInBrowser, strInBrowser);
			// await page.tracing.start({ path: 'profile.json' });
			await page.goto('https://deepmess.com/namerena/index.html', { timeout: 0 });
		} catch (e) {
			console.error(`[task] Failed to unbox ${name} ${mode}: ${e.message}`);
		}
	}));
	cluster.on('taskerror', (err, data, willRetry) => {
		if (willRetry)
			console.warn(`Encountered an error while unboxing ${data}. ${err.message}\nThis job will be retried`);
		else
			console.error(`Failed to unbox ${data}: ${err.message}`);
	});

	// init
	let inputRaw;
	if (process.argv.length > 2)
		inputRaw = await fetch(process.argv[2]).then(x => x.text());
	else
		inputRaw = fs.readFileSync(path.join(__dirname, 'input'), 'utf8');
	let inputNames = inputRaw.split('\n').map(x => x.trim()).filter(x => x.length);

	insertManyNames(inputNames.map(name => {
		if (name.endsWith('+')) name = name.slice(0, -1);
		return name;
	}));
	for (let name of inputNames) {
		let plusFlag = false;
		if (name.endsWith('+')) {
			name = name.slice(0, -1);
			plusFlag = true;
		}
		if (!name.length) process.exit(0);

		for (let mode in config) {
			if (typeof config[mode] !== 'object') continue;
			if (!config[mode].mode.includes('P') && !(plusFlag && config[mode].mode.includes('+'))) continue;

			const serializedItem = JSON.stringify([mode, name]);
			fullQueue.add(serializedItem);
		}
	}

	for (let task of fullQueue)
		await cluster.queue(JSON.parse(task));

	console.log(`queue size: ${fullQueue.size}`);

	await cluster.idle();
	await cluster.close();
})();