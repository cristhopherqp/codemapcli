const someArray = ["Minjeong", 25];

const nameOrAge = (someArray) => {

  someArray.forEach(elem => {
    if (typeof elem === "string" ){
      console.log(`Hi, my name is ${someArray[0]}`)
    };

    console.log(`I'm ${someArray[1]} years old.`)
  }); 

};

nameOrAge(someArray);


