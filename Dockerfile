FROM livingdocs/node:16
ADD package*.json /app/
ENV NODE_ENV=production
RUN npm ci
ADD ./ /app
CMD ["node", "index.js"]
