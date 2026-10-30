#import <UIKit/UIKit.h>

// Offline UIKit fixture with a genuine system keyboard and an ordinary blinking
// UITextField caret. The App does not expose its field or painted controls via AX.
@interface BFSKeyboardCanvas : UIView <UITextFieldDelegate>
@property(nonatomic,strong) UITextField *field;
@property(nonatomic,copy) NSString *mode;
@property(nonatomic,copy) NSString *result;
@property(nonatomic) NSUInteger queryCount;
- (void)resetToMode:(NSString *)mode;
@end
@implementation BFSKeyboardCanvas
- (instancetype)initWithFrame:(CGRect)frame {
 if ((self=[super initWithFrame:frame])) {
  self.backgroundColor=UIColor.whiteColor;
  self.isAccessibilityElement=NO;self.accessibilityElementsHidden=YES;
  self.field=[[UITextField alloc] initWithFrame:CGRectZero];
  self.field.font=[UIFont boldSystemFontOfSize:30];self.field.textColor=UIColor.blackColor;
  self.field.backgroundColor=UIColor.whiteColor;self.field.borderStyle=UITextBorderStyleNone;
  self.field.isAccessibilityElement=NO;self.field.accessibilityElementsHidden=YES;
  self.field.delegate=self;self.field.keyboardType=UIKeyboardTypeASCIICapable;
  self.field.autocapitalizationType=UITextAutocapitalizationTypeNone;
  self.field.autocorrectionType=UITextAutocorrectionTypeNo;
  self.field.spellCheckingType=UITextSpellCheckingTypeNo;
  self.field.smartQuotesType=UITextSmartQuotesTypeNo;
  self.field.smartDashesType=UITextSmartDashesTypeNo;
  self.field.smartInsertDeleteType=UITextSmartInsertDeleteTypeNo;
  self.field.inputAssistantItem.leadingBarButtonGroups=@[];
  self.field.inputAssistantItem.trailingBarButtonGroups=@[];
  [self.field addTarget:self action:@selector(edited:) forControlEvents:UIControlEventEditingChanged];
  [self addSubview:self.field];[self resetToMode:@"normal"];
 }
 return self;
}
- (void)layoutSubviews {
 [super layoutSubviews];CGFloat w=self.bounds.size.width,h=self.bounds.size.height;
 self.field.frame=CGRectMake(w*.08,h*.20,w*.84,h*.08);
}
- (void)resetToMode:(NSString *)mode {
 if (![@[@"normal",@"ignore_input",@"autoupdate_noop"] containsObject:mode])return;
 [self.field resignFirstResponder];self.mode=mode;self.field.text=@"";self.queryCount=0;
 self.result=[mode isEqualToString:@"ignore_input"]?@"RESULT IGNORE":[mode isEqualToString:@"autoupdate_noop"]?@"RESULT AUTO":@"RESULT NONE";
 [self setNeedsDisplay];
}
- (BOOL)textField:(UITextField *)field shouldChangeCharactersInRange:(NSRange)range replacementString:(NSString *)string {
 if ([self.mode isEqualToString:@"ignore_input"])return NO;
 NSString *next=[field.text stringByReplacingCharactersInRange:range withString:string];
 return next.length<=32&&[next rangeOfCharacterFromSet:[[NSCharacterSet alphanumericCharacterSet] invertedSet]].location==NSNotFound;
}
- (void)edited:(UITextField *)field {
 if ([self.mode isEqualToString:@"autoupdate_noop"])self.result=[NSString stringWithFormat:@"RESULT %@ AUTO",field.text];
 [self setNeedsDisplay];
}
- (void)drawRect:(CGRect)rect {
 CGFloat w=self.bounds.size.width,h=self.bounds.size.height;
 NSDictionary *attrs=@{NSFontAttributeName:[UIFont boldSystemFontOfSize:30],NSForegroundColorAttributeName:UIColor.blackColor};
 [@"Query" drawAtPoint:CGPointMake(w*.12,h*.13) withAttributes:attrs];
 [@"Search" drawAtPoint:CGPointMake(w*.12,h*.33) withAttributes:attrs];
 [@"Dismiss" drawAtPoint:CGPointMake(w*.58,h*.33) withAttributes:attrs];
 [self.result drawAtPoint:CGPointMake(w*.12,h*.48) withAttributes:attrs];
}
- (void)touchesEnded:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
 CGPoint p=[[touches anyObject] locationInView:self];CGFloat y=p.y/self.bounds.size.height;
 if(y>=.12&&y<.19){[self.field becomeFirstResponder];return;}
 if(y>=.32&&y<.40){
  if(p.x>self.bounds.size.width*.5){[self.field resignFirstResponder];return;}
  // Querying never hides the keyboard as a hidden test-side fallback.
  if(self.field.isFirstResponder)return;
  if(![self.mode isEqualToString:@"autoupdate_noop"]){self.queryCount++;self.result=[NSString stringWithFormat:@"RESULT %@ %lu",self.field.text,(unsigned long)self.queryCount];[self setNeedsDisplay];}
 }
}
@end

@interface BFSDemoController : UIViewController @end
@implementation BFSDemoController
- (void)loadView { self.view = [[BFSKeyboardCanvas alloc] initWithFrame:UIScreen.mainScreen.bounds]; }
- (BOOL)prefersStatusBarHidden { return YES; }
@end

// UIKit may deliver a URL through a scene or the application delegate. Both
// paths use the same local mode-only handler; input values never come from URL.
static NSURL *BFSPendingModeURL;
static NSString *BFSLastAppliedModeURL;
static BOOL BFSApplyModeURL(NSURL *url, NSString *source, UIWindow *preferredWindow) {
    if (!url) return NO;
    NSLog(@"BFS_MODE_RECEIVED source=%@ url=%@", source, url.absoluteString);
    if (![url.scheme.lowercaseString isEqualToString:@"bfsmcpvisualkeyboard"] ||
        ![url.host.lowercaseString isEqualToString:@"mode"]) return NO;
    NSString *mode = [url.path stringByTrimmingCharactersInSet:
        [NSCharacterSet characterSetWithCharactersInString:@"/"]];
    if (![@[@"normal", @"ignore_input", @"autoupdate_noop"] containsObject:mode]) return NO;
    if ([BFSLastAppliedModeURL isEqualToString:url.absoluteString]) {
        NSLog(@"BFS_MODE_DUPLICATE source=%@ mode=%@", source, mode);
        return YES;
    }
    NSMutableArray<UIWindow *> *windows = [NSMutableArray array];
    if (preferredWindow) [windows addObject:preferredWindow];
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if ([scene isKindOfClass:UIWindowScene.class]) {
            for (UIWindow *window in ((UIWindowScene *)scene).windows) {
                if (![windows containsObject:window]) [windows addObject:window];
            }
        }
    }
    // The fallback also works when a simulator chooses the legacy application
    // URL callback even though the app's visible window was created by a scene.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    for (UIWindow *window in UIApplication.sharedApplication.windows) {
        if (![windows containsObject:window]) [windows addObject:window];
    }
#pragma clang diagnostic pop
    for (UIWindow *window in windows) {
        UIView *view = window.rootViewController.view;
        if ([view isKindOfClass:BFSKeyboardCanvas.class]) {
            [(BFSKeyboardCanvas *)view resetToMode:mode];
            BFSLastAppliedModeURL = url.absoluteString;
            BFSPendingModeURL = nil;
            NSLog(@"BFS_MODE_APPLIED source=%@ mode=%@", source, mode);
            return YES;
        }
    }
    BFSPendingModeURL = url;
    NSLog(@"BFS_MODE_DEFERRED source=%@ mode=%@ windows=%lu", source, mode,
          (unsigned long)windows.count);
    return YES;
}

@interface BFSDemoSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
@end
@implementation BFSDemoSceneDelegate
- (void)applyURL:(NSURL *)url {
    BFSApplyModeURL(url, @"scene.openURLContexts", self.window);
}
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
    if (![scene isKindOfClass:UIWindowScene.class]) return;
    self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
    self.window.rootViewController = [BFSDemoController new];
    [self.window makeKeyAndVisible];
    for (UIOpenURLContext *context in options.URLContexts) [self applyURL:context.URL];
    if (BFSPendingModeURL) BFSApplyModeURL(BFSPendingModeURL, @"scene.connected.pending", self.window);
}
- (void)scene:(UIScene *)scene openURLContexts:(NSSet<UIOpenURLContext *> *)contexts {
    for (UIOpenURLContext *context in contexts) [self applyURL:context.URL];
}
- (void)sceneDidBecomeActive:(UIScene *)scene {
    if (BFSPendingModeURL) BFSApplyModeURL(BFSPendingModeURL, @"scene.active.pending", self.window);
}
@end

@interface BFSDemoDelegate : UIResponder <UIApplicationDelegate> @end
@implementation BFSDemoDelegate
- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)options {
    NSURL *url = options[UIApplicationLaunchOptionsURLKey];
    if (url) BFSApplyModeURL(url, @"application.launch", nil);
    return YES;
}
- (BOOL)application:(UIApplication *)application openURL:(NSURL *)url options:(NSDictionary<UIApplicationOpenURLOptionsKey,id> *)options {
    return BFSApplyModeURL(url, @"application.openURL", nil);
}
- (void)applicationDidBecomeActive:(UIApplication *)application {
    if (BFSPendingModeURL) BFSApplyModeURL(BFSPendingModeURL, @"application.active.pending", nil);
}
- (UISceneConfiguration *)application:(UIApplication *)application configurationForConnectingSceneSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
    UISceneConfiguration *config = [[UISceneConfiguration alloc] initWithName:@"Default Configuration" sessionRole:session.role];
    config.delegateClass = BFSDemoSceneDelegate.class;
    return config;
}
@end
int main(int argc, char *argv[]) {
    @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass(BFSDemoDelegate.class)); }
}
