# Dockerfile
# Defines the Docker image for the Stremio Real-Debrid Addon.

# Use an official Node.js runtime as the base image
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json (if exists) to the working directory
# This allows caching of dependencies
COPY package*.json ./

# Install dependencies (will now include 'pg' instead of Prisma)
RUN npm install --omit=dev

# Copy the rest of the application code to the working directory
COPY . .

# Expose the port the app runs on
EXPOSE 7000

# Command to run the application
# Use 'npm start' as defined in package.json
CMD ["npm", "start"]
