# Rhythm

> An open-source music library and personal music ecosystem, inspired by the best ideas from existing music-management applications and built around music that the user owns.

**Project status:** Early design / specification  
**Specification version:** 0.1  
**License:** To be decided

---

## 1. What is Rhythm?

Rhythm is an open-source project intended to become a modern, user-controlled music management system.

Its starting point is a desktop application for managing a personal collection of music files. The application should make it possible to discover, organise, inspect, edit and play that collection in a coherent way.

The longer-term vision goes beyond a desktop player. Rhythm may eventually become a personal music ecosystem in which a user's library, playlists and listening organisation can move between devices, while using storage and services that the user controls or already subscribes to.

The desktop experience will take inspiration from applications such as **Rhythmbox**, while functionality and interface ideas may also be studied from other music-management applications.

Rhythm is **not intended to be a clone of any existing application**. Existing software is useful as a source of ideas and as evidence of problems that have already been solved.

---

## 2. The Problem

Managing a personal music collection can become surprisingly difficult as the collection grows.

Music may exist across multiple folders, disks and devices. Metadata may be incomplete or inconsistent. Playlists may be tied to a particular application or device. Different applications may represent the same library differently.

Modern streaming services solve many problems by moving the centre of the experience into their own ecosystems. That works well for streaming, but it does not necessarily solve the problem of managing a person's **own collection of music files**.

Rhythm begins with a simpler question:

> **How can a person manage their own digital music collection as a coherent library, rather than merely as a collection of files scattered across storage locations?**

The larger question is:

> **Can that personal library become portable across applications and devices without surrendering ownership and control to a single platform?**

---

## 3. Who is Rhythm for?

The initial target user is someone who:

- owns a collection of digital music files;
- wants a proper library rather than relying solely on folders and filenames;
- wants to organise and edit metadata;
- creates playlists;
- may use more than one device;
- values control over their own files and data;
- does not want their personal music collection to be completely dependent on a single commercial ecosystem.

The project may eventually serve a broader audience, but the initial design should remain focused on solving the core personal-library problem well.

---

## 4. Initial Goals

The first meaningful version of Rhythm should explore the fundamentals of managing a local music library.

### Library management

Rhythm should eventually be able to:

- scan selected locations for music files;
- build an internal representation of the user's library;
- identify and display tracks and their metadata;
- organise music by meaningful attributes such as artist, album and genre;
- detect changes in the underlying files;
- allow users to edit appropriate metadata.

### Playback

The application should eventually provide the basic experience expected from a desktop music player:

- selecting music;
- playing and pausing tracks;
- navigating between tracks;
- browsing the library;
- creating and playing playlists.

Playback is important, but it is not the sole purpose of the project. The library and its underlying model are central.

### Playlists

Rhythm should provide a way to create and manage playlists independently of a particular playback session.

The project should eventually investigate how playlists can remain meaningful when music is moved between devices or storage locations.

### Ownership and portability

The project should favour designs that preserve the user's control over:

- their music files;
- their metadata;
- their playlists;
- their library information.

The exact mechanisms for achieving this are deliberately not decided yet.

---

## 5. Longer-Term Direction

The larger vision previously identified for Rhythm includes:

### Multiple devices

Potential clients could eventually include:

- desktop;
- Android;
- iOS;
- potentially other platforms.

The existence of these clients is **not part of the initial implementation scope**.

### Synchronisation

A future Rhythm ecosystem could allow playlists and selected library information to be synchronised between devices.

This raises significant engineering questions around:

- identity;
- synchronisation;
- conflicts;
- offline changes;
- versioning;
- file availability;
- metadata changes.

These problems should be studied before implementation rather than solved prematurely.

### Cloud storage

The longer-term concept includes allowing users to use cloud storage they already subscribe to, rather than requiring Rhythm to become a proprietary music-storage service.

Exactly what should be stored in the cloud—and what should remain local—is an unresolved design question.

---

## 6. What Rhythm Is Not

At this stage, Rhythm is explicitly **not**:

- a streaming service;
- a replacement for Spotify, Apple Music or similar services;
- a proprietary cloud music service;
- a social network for music;
- a project whose purpose is to reproduce Rhythmbox feature-for-feature;
- a multi-platform application from day one;
- an excuse to introduce distributed systems, microservices or other complex infrastructure before the underlying problem requires them.

The project should resist scope expansion simply because a technology makes something possible.

---

## 7. Initial Scope

The first implementation should remain deliberately small.

A plausible first useful milestone is a desktop application that can:

1. inspect selected music directories;
2. identify supported music files;
3. extract and represent their metadata;
4. build a persistent local library;
5. allow the user to browse that library;
6. play selected tracks;
7. create basic playlists.

This is a **working hypothesis, not a final requirements specification**.

The exact supported formats, metadata behaviour, persistence model, user interface and playback architecture still need investigation.

---

## 8. Explicitly Out of Scope for the First Version

The following should not become early implementation requirements:

- mobile applications;
- cloud synchronisation;
- multi-device synchronisation;
- distributed infrastructure;
- user accounts;
- social features;
- music streaming;
- recommendation algorithms;
- artificial intelligence features;
- elaborate plugin systems;
- complex server infrastructure;
- automatic conflict resolution across multiple devices.

Some of these may eventually belong in Rhythm. Their existence in the long-term vision does not make them appropriate for version one.

---

## 9. Important Design Principles

### Understand before implementing

Important architectural decisions should be understood before they are implemented.

### Start with the smallest useful system

Rhythm should grow from a working core rather than attempting to implement the entire ecosystem at once.

### Prefer simple architecture

Complexity should have a reason to exist.

If a simpler design solves the current problem, the simpler design should normally win.

### Separate the user's data from the application

The user's music collection should not become conceptually equivalent to the application's internal state.

The project should carefully distinguish between:

- music files;
- metadata contained in those files;
- Rhythm's representation of the library;
- playlists;
- synchronisation state;
- application configuration.

The exact boundaries still need to be designed.

### Make important decisions explainable

A future contributor should be able to understand not only **what** Rhythm does, but **why** it was designed that way.

### Open Source from the beginning

Documentation, architecture and code should be developed with future contributors and learners in mind.

---

## 10. Questions We Still Need to Investigate

These are deliberately unanswered.

### Music files

- Which audio formats should the first version support?
- Should Rhythm modify metadata inside files, maintain its own metadata, or support both?
- How should missing or contradictory metadata be handled?
- How should duplicate files be identified?
- What happens when files are moved or renamed outside Rhythm?
- How should removable and external storage be represented?

### Library model

- What exactly constitutes a "track" in Rhythm?
- How should albums, artists, compilations and other relationships be represented?
- Which information belongs to the music file and which belongs to the Rhythm library?
- What should happen when the same physical file can be reached through different paths?
- How should the library remain consistent with the filesystem?

### Playlists

- Are playlists references to files, tracks, stable identities, or something else?
- How should playlists survive file moves?
- Should playlists be portable outside Rhythm?
- Should Rhythm support existing playlist formats?

### Persistence

- What information needs to be stored persistently?
- Does Rhythm actually need a database at the beginning?
- If it does, what problem is the database solving?
- What is the minimum data model required?

### Playback

- Should playback be considered part of the core domain or an infrastructure concern?
- What audio engine should eventually be used?
- How much playback functionality belongs inside Rhythm itself?

### Synchronisation

- What exactly needs to synchronise?
- What does it mean for two devices to have "the same library"?
- How are conflicts detected?
- How are conflicts resolved?
- What happens when a device is offline?
- How are files distinguished from the metadata describing them?

### Cloud storage

- Should Rhythm communicate directly with existing cloud-storage providers?
- Should Rhythm have its own server component?
- What information, if any, should leave the user's devices?
- How can the architecture avoid coupling the entire application to one provider?

### Privacy and security

- What data should Rhythm collect, if any?
- Should telemetry exist?
- How should credentials and cloud-service access be handled?
- What security model is appropriate if synchronisation is eventually introduced?

### User interface

- Which ideas from Rhythmbox are worth preserving?
- Which problems do other music applications solve better?
- What should the primary mental model of the interface be?
- How much of the filesystem should the user see?
- How should a large music collection remain navigable?

---

## 11. What We Know vs. What We Don't

### We know

- Rhythm will be Open Source.
- It will begin with personal music-library management.
- The desktop application is the natural starting point.
- Rhythmbox is an important source of inspiration for the desktop experience.
- Other applications may be studied for useful functionality and interface ideas.
- The long-term vision may include multiple devices, playlist synchronisation and use of user-controlled or existing cloud storage.
- The project should prioritise ownership, portability and understandable architecture.
- Development should proceed incrementally.

### We do not yet know

- the programming language;
- the UI toolkit;
- the target desktop platform(s) beyond the initial Linux orientation;
- the audio engine;
- the database or persistence technology;
- the exact domain model;
- the synchronisation protocol;
- the cloud architecture;
- the final user interface;
- the precise licensing model.

These are design decisions, not assumptions.

---

## 12. Development Philosophy

Rhythm will be developed through a cycle:

**Idea → artefact → discovery → research → implementation → evaluation → refinement**

An artefact might be:

- a written requirement;
- a domain model;
- a diagram;
- a prototype;
- a test;
- a script;
- documentation;
- or working software.

The project does not need to be completely understood before work begins.

At the same time, implementation should not be used as a substitute for understanding a problem that has not yet been defined.

The objective is **progress through deliberate learning**.

---

## 13. Current Next Step

This document is the first stone, not the blueprint for the entire mountain.

The next stage is to turn the broad problem into a clearer **problem statement and initial requirements**, while identifying which assumptions need to be tested.

Only after those questions have enough clarity should major architectural and technology decisions be made.

---

## 14. Project Status

Rhythm is currently in the **early specification and discovery stage**.

Nothing in this document should be treated as immutable.

The README is expected to evolve as the project evolves.

When implementation reveals that an assumption was wrong, the documentation should change rather than forcing the code to preserve an outdated idea.

---

## 15. Repository

Repository: *To be created / confirmed*

---

## 16. License

*To be decided.*
