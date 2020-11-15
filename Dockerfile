FROM livingdocs/node:14
ADD package*.json /app/
RUN npm ci
ADD ./ /app
CMD node index.js
