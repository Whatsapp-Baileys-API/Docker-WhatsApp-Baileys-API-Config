# Use an official Node.js 20 image as the base
FROM node:20-slim

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json first
# This uses Docker's cache to speed up builds
COPY package*.json ./

# Install all dependencies
RUN npm install

# Copy all your application code (src folder, etc.)
COPY . .

# Expose port 3000 (the port your app listens on)
EXPOSE 3000

# The command to run when the container starts
CMD [ "npm", "start" ]

