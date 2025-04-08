#!/bin/bash

set -e

version="$1"

if [[ "$version" == "" ]]; then
    echo 'Release branch name must be given as first argument' >&2
    exit 1
fi

if [ ! -d .git ]; then
    echo 'This script must be run at root directory of this repository' >&2
    exit 1
fi

if ! git diff --quiet; then
    echo 'Working tree is dirty! Please ensure all changes are committed and working tree is clean' >&2
    exit 1
fi

if ! git diff --cached --quiet; then
    echo 'Git index is dirty! Please ensure all changes are committed and Git index is clean' >&2
    exit 1
fi

branch="$(git symbolic-ref --short HEAD)"
if [[ "$branch" != "main" ]]; then
    echo 'Current branch is not main. Please move to main before running this script' >&2
    exit 1
fi

echo "Releasing to $version branch..."

rm -rf dist

set -x
npm install
npm run build
npm run lint
npm test
npm prune --production

rm -rf .release
mkdir -p .release

cp action.yml action-types.yml package.json package-lock.json src/default_index.html .release/
rsync -R -v dist/src/*.js .release/
rsync -R -v dist/src/**/*.js .release/
cp -R node_modules .release/node_modules

git checkout "$version"
git pull
git rm -rf --ignore-unmatch node_modules
rm -rf node_modules  # remove node_modules/.cache

rm -rf dist
mkdir -p dist/src

mv .release/action.yml .
mv .release/action-types.yml .
mv .release/default_index.html ./dist/src
mv .release/dist/src/ ./dist/
mv .release/*.json .
mv .release/node_modules .

git add action.yml action-types.yml ./dist/src/default_index.html ./dist/src/*.js ./dist/src/comment/*.js package.json package-lock.json node_modules
set +x

echo "Done. Please check 'git diff --cached' to verify changes. If ok, add version tag and push it to remote"
