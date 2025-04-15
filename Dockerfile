FROM apify/actor-node-puppeteer-chrome:latest

COPY . ./

RUN npm install --only=prod --no-optional --quiet

CMD ["npm", "start"]
