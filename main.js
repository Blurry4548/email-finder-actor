import { Actor } from 'apify';
import { PuppeteerCrawler, log, Dataset } from 'crawlee';

await Actor.init();

const { fullName, domain } = await Actor.getInput();

if (!fullName || !domain) throw new Error('Missing fullName or domain');

const nameParts = fullName.toLowerCase().split(' ');

const emailsFound = [];

const crawler = new PuppeteerCrawler({
    requestHandler: async ({ page, request }) => {
        log.info(`Visiting ${request.url}`);

        const pageContent = await page.content();
        const text = await page.evaluate(() => document.body.innerText);
        const pageUrl = page.url();

        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g;
        const emails = pageContent.match(emailRegex) || [];

        const normalizedText = text.toLowerCase();
        const containsName = nameParts.every(part => normalizedText.includes(part));

        if (containsName && emails.length > 0) {
            emailsFound.push(...emails);
        }

        const links = await page.$$eval('a', as => as.map(a => a.href));
        for (const link of links) {
            if (link.includes(domain) && !link.includes('mailto')) {
                await crawler.addRequests([link]);
            }
        }
    },
    maxRequestsPerCrawl: 10,
    maxConcurrency: 2,
    headless: true,
    launchContext: {
        launchOptions: {
            args: ['--no-sandbox'],
        },
    },
});

await crawler.run([`https://${domain}`]);

await Dataset.pushData({
    fullName,
    domain,
    emails: [...new Set(emailsFound)],
});

await Actor.exit();
