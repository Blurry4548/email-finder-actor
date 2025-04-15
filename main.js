// Trigger rebuild: ensure Apify uses correct Docker template
import { Actor } from 'apify';
import { PuppeteerCrawler, log, Dataset } from 'crawlee';

await Actor.init();

const { fullName, domain } = await Actor.getInput();

if (!fullName || !domain) throw new Error('Missing fullName or domain');

const nameParts = fullName.toLowerCase().split(' ');

const emailsFound = [];

const PRIORITY_KEYWORDS = [
    'staff', 'team', 'leadership', 'people', 'directory', 'about', 'contact', 'faculty', 'our-team', 'employees', 'personnel', 'who-we-are'
];

function isHighPriority(url, text) {
    const lcUrl = url.toLowerCase();
    const lcText = (text || '').toLowerCase();
    return PRIORITY_KEYWORDS.some(kw =>
        lcUrl.includes(kw) || lcText.includes(kw)
    );
}

const crawler = new PuppeteerCrawler({
    requestHandler: async ({ page, request, enqueueLinks, log }) => {
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
        } else if (emails.length > 0 && emailsFound.length === 0) {
            // Fallback: store general emails if no personal ones found
            emailsFound.push(...emails);
        }

        // Extract all links with both href and visible text
        const links = await page.$$eval('a', as => as.map(a => ({ href: a.href, text: a.innerText })));
        const uniqueLinks = Array.from(new Set(links.map(l => l.href)))
            .map(href => links.find(l => l.href === href));

        // Partition links by priority
        const highPriorityLinks = uniqueLinks.filter(l =>
            l.href.includes(domain) &&
            !l.href.includes('mailto') &&
            isHighPriority(l.href, l.text)
        );
        const normalLinks = uniqueLinks.filter(l =>
            l.href.includes(domain) &&
            !l.href.includes('mailto') &&
            !isHighPriority(l.href, l.text)
        );

        // Add high-priority links first, then normal links
        for (const link of highPriorityLinks) {
            await crawler.addRequests([link.href]);
        }
        for (const link of normalLinks) {
            await crawler.addRequests([link.href]);
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
