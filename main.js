// Trigger rebuild: ensure Apify uses correct Docker template
import { Actor } from 'apify';
import { PuppeteerCrawler, log, Dataset } from 'crawlee';

await Actor.init();

const { fullName, domain } = await Actor.getInput();

if (!fullName || !domain) throw new Error('Missing fullName or domain');

const nameParts = fullName.toLowerCase().split(' ');

const emailsFound = [];

const GOOD_LINK_KEYWORDS = [
    'staff', 'team', 'leadership', 'people', 'directory', 'about', 'contact', 'faculty', 'our-team', 'employees', 'personnel', 'who-we-are'
];
const BAD_LINK_KEYWORDS = [
    'blog', 'news', 'donate', 'service', 'services', 'event', 'events', 'career', 'careers', 'volunteer', 'give', 'program', 'calendar', 'story', 'stories', 'press', 'media', 'resources', 'covid', 'policy', 'privacy', 'terms', 'faq', 'testimonials', 'partners', 'board', 'history', 'mission', 'vision'
];

function isAllowedLink(url, text) {
    const lcUrl = url.toLowerCase();
    const lcText = (text || '').toLowerCase();
    // Must match at least one GOOD keyword
    const matchesGood = GOOD_LINK_KEYWORDS.some(kw => lcUrl.includes(kw) || lcText.includes(kw));
    // Must not match any BAD keyword
    const matchesBad = BAD_LINK_KEYWORDS.some(kw => lcUrl.includes(kw) || lcText.includes(kw));
    return matchesGood && !matchesBad;
}


const crawler = new PuppeteerCrawler({
    navigationTimeoutSecs: 10, // Fail even faster on slow/unresponsive sites
    maxRequestRetries: 0, // Only try each homepage variant once
    requestHandler: async ({ page, request, enqueueLinks, log }) => {
        log.info(`Visiting ${request.url}`);

        const pageContent = await page.content();
        const text = await page.evaluate(() => document.body.innerText);
        const pageUrl = page.url();

        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g;
        const allEmails = pageContent.match(emailRegex) || [];
        log.info(`Found ${allEmails.length} email(s) on this page: ${allEmails.join(', ')}`);
        const domainEmails = allEmails.filter(email => email.toLowerCase().endsWith('@' + domain.toLowerCase()));
        const skippedEmails = allEmails.filter(email => !email.toLowerCase().endsWith('@' + domain.toLowerCase()));
        if (skippedEmails.length > 0) {
            log.info(`Skipped ${skippedEmails.length} email(s) not matching @${domain}: ${skippedEmails.join(', ')}`);
        }
        log.info(`Retained ${domainEmails.length} email(s) matching @${domain}: ${domainEmails.join(', ')}`);

        const normalizedText = text.toLowerCase();
        const containsName = nameParts.every(part => normalizedText.includes(part));
        log.info(`Does page contain all name parts (${nameParts.join(', ')}): ${containsName}`);

        if (containsName && domainEmails.length > 0) {
            log.info(`Adding ${domainEmails.length} email(s) because name was found.`);
            emailsFound.push(...domainEmails);
        } else if (domainEmails.length > 0 && emailsFound.length === 0) {
            // Fallback: store general emails if no personal ones found
            log.info(`Adding ${domainEmails.length} fallback email(s) because no personal email found yet.`);
            emailsFound.push(...domainEmails);
        } else {
            log.info('No emails added from this page.');
        }

        // Extract all links with both href and visible text
        const links = await page.$$eval('a', as => as.map(a => ({ href: a.href, text: a.innerText })));
        const uniqueLinks = Array.from(new Set(links.map(l => l.href)))
            .map(href => links.find(l => l.href === href));

        // Only allow links that match good keywords and not bad ones
        const allowedLinks = uniqueLinks.filter(l =>
            l.href.includes(domain) &&
            !l.href.includes('mailto') &&
            isAllowedLink(l.href, l.text)
        );

        // Only add allowed links
        for (const link of allowedLinks) {
            await crawler.addRequests([link.href]);
        }
    },
    maxRequestsPerCrawl: 10,
    failedRequestHandler: async ({ request, error, log, crawler }) => {
        log.error(`Request to ${request.url} failed: ${error.message}`);
        // Only apply fallback for the initial homepage request
        const urlObj = new URL(request.url);
        const isRoot = urlObj.pathname === '/' || urlObj.pathname === '';
        const isHttps = urlObj.protocol === 'https:';
        const isNoSubdomain = urlObj.hostname.split('.').length === 2;
        // Only try fallback if it's the first/root request and no subdomain (e.g. parisisd.net)
        if (isRoot && isHttps && isNoSubdomain && !request.userData.fallbackTried) {
            // Try https://www.domain
            const wwwUrl = urlObj.origin.replace('://', '://www.') + '/';
            log.info(`Retrying with www subdomain: ${wwwUrl}`);
            await crawler.addRequests([{
                url: wwwUrl,
                userData: { fallbackTried: true }
            }]);
        } else if (isRoot && isHttps && urlObj.hostname.startsWith('www.') && !request.userData.httpTried) {
            // Try http://www.domain
            const httpUrl = 'http://' + urlObj.hostname + '/';
            log.info(`Retrying with http: ${httpUrl}`);
            await crawler.addRequests([{
                url: httpUrl,
                userData: { httpTried: true }
            }]);
        } else {
            log.error('All homepage fallbacks failed. Aborting early to save cost.');
            process.exit(1); // Abort the actor immediately
        }
    },
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
