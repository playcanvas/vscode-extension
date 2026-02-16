#!/bin/bash

TYPE=$1

# Check if type is valid
if [[ "$TYPE" != "major" && "$TYPE" != "minor" && "$TYPE" != "patch" && "$TYPE" != "prerelease" ]]; then
    echo "Usage: $0 <major|minor|patch|prerelease>"
    exit 1
fi

# Check if on main branch
if [[ $(git branch --show-current) != "main" ]]; then
    echo "You are not on the main branch. Please switch to the main branch before running this script."
    exit 1
fi

# Check for any uncommitted changes (unstaged or staged)
if [[ $(git status --porcelain) ]]; then
    echo "There are uncommitted changes. Please commit or stash them before running this script."
    exit 1
fi

# npm version
if [[ "$TYPE" == "prerelease" ]]; then
    VERSION=$(npm version prerelease --preid=beta --no-git-tag-version)
else
    VERSION=$(npm version $TYPE --no-git-tag-version)
fi

# ask for confirmation
read -p "Are you sure you want to release version $VERSION? (y/n) " -n 1 -r
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborting..."
    exit 1
fi

# push the changes and tags
git push origin main --follow-tags